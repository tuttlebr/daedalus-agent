//! Filesystem skill discovery, progressive disclosure and explicit script opt-in.
use crate::{
    document_search::Failure,
    memory_tools::{json_text, trim},
};
use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::{Component, Path, PathBuf},
    sync::{LazyLock, Mutex},
};

static CONTRACT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("../resources/agent-skills.json")).unwrap());
const OPERATIONS: [&str; 3] = ["list_skills", "load_skill", "run_skill_script"];
static FRONTMATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)^---[\s\u001c-\u001f]*\n(.*?)\n---[\s\u001c-\u001f]*\n").unwrap()
});
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());
static YAML_NON_STRING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        &CONTRACT["yaml_scalar_patterns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| format!("(?x:\n{}\n)", v.as_str().unwrap()))
            .collect::<Vec<_>>()
            .join("|"),
    )
    .unwrap()
});
static INPUTS: LazyLock<Vec<jsonschema::Validator>> = LazyLock::new(|| {
    fn patterns(schema: &mut Value) {
        if schema.get("pattern").is_some_and(|v| v == "\\S") {
            schema["pattern"] = json!(r"[^\s\u001c-\u001f]");
        }
        match schema {
            Value::Object(v) => v.values_mut().for_each(patterns),
            Value::Array(v) => v.iter_mut().for_each(patterns),
            _ => (),
        }
    }
    (0..8)
        .map(|mask| {
            let mut schema = CONTRACT["schemas"][mask.to_string()]["parameters"].clone();
            patterns(&mut schema);
            jsonschema::options()
                .should_validate_formats(false)
                .build(&schema)
                .unwrap()
        })
        .collect()
});

pub struct Settings {
    pub values: Value,
    mask: usize,
}
impl Settings {
    pub fn exposes_loading(&self) -> bool {
        self.mask & 2 != 0
    }
    pub fn new(raw: &Value) -> Result<Self> {
        let mut values = CONTRACT["defaults"].clone();
        let properties = CONTRACT["configuration_schema"]["properties"]
            .as_object()
            .unwrap();
        for (key, value) in raw
            .as_object()
            .ok_or_else(|| anyhow!("Invalid skill configuration"))?
        {
            if key == "_type" && value == "agent_skills" {
                continue;
            }
            values[key] = crate::document_tools::coerce(
                value,
                properties
                    .get(key)
                    .ok_or_else(|| anyhow!("Unknown skill configuration field"))?,
            )?;
        }
        if !values["script_timeout"]
            .as_u64()
            .is_some_and(|n| (1..=300).contains(&n))
        {
            bail!("Invalid script timeout");
        }
        let mut mask = 7;
        if let Some(operations) = values["enabled_operations"].as_array() {
            mask = 0;
            for operation in operations {
                let index = OPERATIONS
                    .iter()
                    .position(|name| operation == name)
                    .ok_or_else(|| anyhow!("Invalid skill operation"))?;
                mask |= 1 << index;
            }
        }
        if values["allow_script_execution"] != true {
            mask &= 3;
        }
        Ok(Self { values, mask })
    }
    pub fn schema(&self, name: &str) -> Result<Value> {
        let description = self.values["description"].as_str().unwrap();
        let description = if description.is_empty() {
            CONTRACT["fallback_description"].as_str().unwrap()
        } else {
            description
        };
        if trim(description).is_empty() {
            bail!("Tool requires a nonempty model-facing description");
        }
        let mut schema = CONTRACT["schemas"][self.mask.to_string()].clone();
        schema["name"] = json!(name);
        schema["description"] = json!(description);
        Ok(schema)
    }
    fn arguments(&self, raw: &Value) -> Result<Value> {
        let schema = &CONTRACT["schemas"][self.mask.to_string()]["parameters"];
        let mut errors: Vec<_> = INPUTS[self.mask].iter_errors(raw).collect();
        errors.sort_by_key(|error| {
            let mut current = schema;
            error
                .schema_path()
                .to_string()
                .split('/')
                .skip(1)
                .map(|part| {
                    let rank = current
                        .as_object()
                        .and_then(|m| m.keys().position(|key| key == part))
                        .or_else(|| current.as_array().and_then(|_| part.parse::<usize>().ok()))
                        .unwrap_or(0);
                    current = if current.is_array() {
                        &current[part.parse::<usize>().unwrap()]
                    } else {
                        &current[part]
                    };
                    rank
                })
                .collect::<Vec<_>>()
        });
        let validation = errors.into_iter().take(8).map(|error| {
            let false_schema = matches!(error.kind(), jsonschema::error::ValidationErrorKind::FalseSchema);
            let mut location: Vec<_> = error.instance_path().to_string().split('/').skip(1).map(|part| json!(part.replace("~1", "/").replace("~0", "~"))).collect();
            if false_schema { location.pop(); }
            let keyword = if false_schema { "None" } else { error.kind().keyword() };
            json!({"type":"value_error","loc":location,"msg":format!("Value error, Argument contract: {keyword}"),"ctx":{"error":format!("Argument contract: {keyword}")}})
        }).collect::<Vec<_>>();
        if !validation.is_empty() {
            return Err(Failure {
                class: "ValidationError",
                validation,
            }
            .into());
        }
        Ok(raw.clone())
    }
}

#[derive(Clone)]
struct Metadata {
    name: String,
    description: String,
    directory: PathBuf,
}
impl Metadata {
    fn value(&self) -> Value {
        json!({"name":self.name,"description":self.description})
    }
}
pub struct Parser {
    skills: Vec<Metadata>,
    instructions: Mutex<HashMap<String, String>>,
}

#[derive(Debug)]
struct TextDecodingError(String);
impl std::fmt::Display for TextDecodingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for TextDecodingError {}
fn read(path: &Path) -> Result<String> {
    let data = std::fs::read(path).map_err(|e| match e.raw_os_error() {
        Some(21) => anyhow::Error::from(Failure::new("IsADirectoryError")),
        Some(20) => anyhow::Error::from(Failure::new("NotADirectoryError")),
        _ => anyhow!(os_error(&e, &path.to_string_lossy())),
    })?;
    let text = String::from_utf8(data).map_err(|error| {
        let failure = error.utf8_error();
        let start = failure.valid_up_to();
        let bytes = error.as_bytes();
        let length = failure.error_len().unwrap_or(bytes.len() - start);
        let reason = if failure.error_len().is_none() {
            "unexpected end of data"
        } else if (0xc2..=0xf4).contains(&bytes[start]) {
            "invalid continuation byte"
        } else {
            "invalid start byte"
        };
        let location = if length == 1 {
            format!("byte 0x{:02x} in position {start}", bytes[start])
        } else {
            format!("bytes in position {start}-{}", start + length - 1)
        };
        TextDecodingError(format!("'utf-8' codec can't decode {location}: {reason}"))
    })?;
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}
fn repr(value: &str) -> String {
    let repr = crate::profile_import::identifier(&json!([value]));
    repr[1..repr.len() - 1].into()
}
fn lower(value: &str) -> String {
    crate::document_detection::lowercase(&value.chars().map(u32::from).collect::<Vec<_>>())
        .into_iter()
        .map(|c| char::from_u32(c).unwrap())
        .collect()
}
fn os_error(error: &std::io::Error, name: &str) -> String {
    let number = error.raw_os_error().unwrap_or(5);
    let message = match number {
        2 => "No such file or directory",
        13 => "Permission denied",
        21 => "Is a directory",
        8 => "Exec format error",
        20 => "Not a directory",
        _ => "Input/output error",
    };
    format!("[Errno {number}] {message}: {}", repr(name))
}
fn frontmatter(raw: &str, directory: &Path) -> Result<Metadata> {
    let capture = FRONTMATTER
        .captures(raw)
        .ok_or_else(|| anyhow!("Missing YAML frontmatter"))?;
    let fields = crate::yaml::string_mapping(capture.get(1).unwrap().as_str(), &YAML_NON_STRING)?;
    let name = fields["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Missing skill name"))?;
    let description = fields["description"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Missing skill description"))?;
    let name = trim(name);
    let description = trim(description);
    if name.chars().count() > 64 || !NAME.is_match(name) || description.chars().count() > 1024 {
        bail!("Invalid skill metadata");
    }
    Ok(Metadata {
        name: name.into(),
        description: description.into(),
        directory: directory.into(),
    })
}

/// pathlib.resolve(strict=False): resolve existing symlinks and normalize
/// missing suffixes before checking containment.
fn resolve(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        bail!("embedded null byte");
    }
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut pending: VecDeque<_> = path
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    let mut result = PathBuf::new();
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        match Path::new(&part).components().next().unwrap() {
            Component::RootDir => result = PathBuf::from("/"),
            Component::CurDir => (),
            Component::ParentDir => {
                result.pop();
            }
            _ => {
                result.push(&part);
                if std::fs::symlink_metadata(&result).is_ok_and(|m| m.is_symlink()) {
                    links += 1;
                    if links > 40 {
                        return Err(Failure::new("RuntimeError").into());
                    }
                    let target = std::fs::read_link(&result)?;
                    result.pop();
                    for component in target.components().rev() {
                        pending.push_front(component.as_os_str().to_owned());
                    }
                }
            }
        }
    }
    Ok(result)
}
impl Parser {
    pub fn discover(root: &Path) -> Result<Self> {
        let mut parser = Self {
            skills: Vec::new(),
            instructions: Mutex::new(HashMap::new()),
        };
        if !root.is_dir() {
            return Ok(parser);
        }
        let mut entries = std::fs::read_dir(root)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort();
        for directory in entries {
            if !directory.is_dir() || !directory.join("SKILL.md").is_file() {
                continue;
            }
            let raw = match read(&directory.join("SKILL.md")) {
                Ok(text) => text,
                Err(error) if error.downcast_ref::<TextDecodingError>().is_some() => continue,
                Err(error) => return Err(error),
            };
            if let Ok(metadata) = frontmatter(&raw, &directory) {
                if let Some(index) = parser.skills.iter().position(|m| m.name == metadata.name) {
                    parser.skills[index] = metadata;
                } else {
                    parser.skills.push(metadata);
                }
            }
        }
        Ok(parser)
    }
    fn metadata(&self, name: &str) -> Result<&Metadata> {
        self.skills
            .iter()
            .find(|m| m.name == name)
            .ok_or_else(|| anyhow!("{}", repr(&format!("Skill not found: {name}"))))
    }
    pub fn names(&self) -> Vec<String> {
        self.skills.iter().map(|m| m.name.clone()).collect()
    }
    fn list(&self, query: Option<&str>) -> String {
        let tokens = query
            .map(lower)
            .unwrap_or_default()
            .split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut skills = self
            .skills
            .iter()
            .filter(|m| {
                query.is_none_or(str::is_empty)
                    || tokens
                        .iter()
                        .any(|t| m.name.contains(t) || lower(&m.description).contains(t))
            })
            .collect::<Vec<_>>();
        skills.sort_by_key(|m| &m.name);
        let value = if skills.is_empty() {
            json!({"skills":[],"message":"No skills found."})
        } else {
            json!({"skills":skills.iter().map(|m| m.value()).collect::<Vec<_>>(),"count":skills.len()})
        };
        json_text(&value, false, true, true)
    }
    fn instructions(&self, name: &str) -> Result<String> {
        let mut cache = self.instructions.lock().unwrap();
        if let Some(value) = cache.get(name) {
            return Ok(value.clone());
        }
        let raw = read(&self.metadata(name)?.directory.join("SKILL.md"))?;
        let text = trim(&raw[FRONTMATTER.find(&raw).map_or(0, |m| m.end())..]).to_owned();
        cache.insert(name.into(), text.clone());
        Ok(text)
    }
    fn contained(&self, name: &str, relative: &str, script: bool) -> Result<PathBuf> {
        let directory = &self.metadata(name)?.directory;
        let resolved = resolve(&directory.join(relative))?;
        let root = resolve(directory)?;
        let kind = if script { "Script" } else { "Resource" };
        if !resolved.starts_with(&root) || script && resolved == root {
            bail!("{kind} path escapes the skill directory: {relative}");
        }
        if !resolved.is_file() {
            bail!("{kind} not found in skill '{name}': {relative}");
        }
        Ok(resolved)
    }
    fn resource(&self, name: &str, relative: &str) -> Result<String> {
        let path = self.contained(name, relative, false)?;
        read(&path).map_err(|error| {
            if error.downcast_ref::<TextDecodingError>().is_some() {
                anyhow!("Resource '{relative}' in skill '{name}' is a binary file and cannot be read as text")
            } else { error }
        })
    }
    fn resources(&self, name: &str) -> Result<Vec<String>> {
        fn visit(root: &Path, path: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
            let Ok(entries) = std::fs::read_dir(path) else {
                return Ok(());
            };
            for entry in entries {
                let path = entry?.path();
                let relative = path.strip_prefix(root)?;
                let hidden = relative.components().any(|part| {
                    let name = part.as_os_str().to_string_lossy();
                    name.starts_with('.') || name == "__pycache__"
                });
                if hidden {
                    continue;
                }
                if path.is_file()
                    && path.file_name().is_none_or(|s| s != "SKILL.md")
                    && !path
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_some_and(|e| ["pyc", "pyo", "sig"].contains(&e))
                {
                    output.push(relative.into());
                }
                if std::fs::symlink_metadata(&path)?.is_dir() {
                    visit(root, &path, output)?;
                }
            }
            Ok(())
        }
        let root = &self.metadata(name)?.directory;
        let mut paths = Vec::new();
        visit(root, root, &mut paths)?;
        paths.sort();
        paths
            .into_iter()
            .map(|p| {
                p.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Failure::new("UnicodeEncodeError").into())
            })
            .collect()
    }
    fn load(
        &self,
        name: &str,
        resource: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(String, Vec<String>)> {
        if !self.skills.iter().any(|m| m.name == name) {
            let names = self.names();
            return Ok((
                format!(
                    "Skill '{name}' not found. Available skills: {}",
                    if names.is_empty() {
                        "(none)".into()
                    } else {
                        names.join(", ")
                    }
                ),
                vec![],
            ));
        }
        let result: Result<(String, Vec<String>)> = (|| {
            if let Some(resource) = resource.filter(|s| !s.is_empty()) {
                return Ok((self.resource(name, resource)?, vec![]));
            }
            let mut text = self.instructions(name)?;
            let mut resources = self.resources(name)?;
            if name == "daily-summary" {
                let bundled = CONTRACT["daily_resources"].as_array().unwrap();
                let contents = bundled
                    .iter()
                    .map(|p| self.resource(name, p.as_str().unwrap()))
                    .collect::<Result<Vec<_>>>()?;
                let clock = daily_clock(&contents[0], now)?;
                text.push_str(&format!(
                    "\n\n## Current date and time (trusted backend clock)\n\n{}",
                    json_text(&clock, false, true, true)
                ));
                for (path, content) in bundled.iter().zip(contents) {
                    text.push_str(&format!(
                        "\n\n---\n\n## Bundled resource: `{}`\n\n{content}",
                        path.as_str().unwrap()
                    ));
                }
                text.push_str("\n\nThe four required daily-summary references above are already loaded. Use them directly; do not request them again.");
                resources.retain(|p| !bundled.iter().any(|v| v == p));
            }
            if !resources.is_empty() {
                text.push_str("\n\n---\n\n**Available resources** (use `load_skill` with the `resource` parameter to read):\n");
                for resource in resources {
                    text.push_str(&format!("- `{resource}`\n"));
                }
            }
            Ok((text, vec![name.into()]))
        })();
        match result {
            Err(error) if error.downcast_ref::<Failure>().is_none() => {
                Ok((format!("Error: {error}"), vec![]))
            }
            other => other,
        }
    }
}
fn daily_clock(policy: &str, now: DateTime<Utc>) -> Result<Value> {
    let invalid = || anyhow!("Daily-summary policy has no valid edition timezone.");
    let value: Value = serde_json::from_str(policy).map_err(|_| invalid())?;
    let name = value["edition"]["timezone"].as_str().ok_or_else(invalid)?;
    let zone: chrono_tz::Tz = name.parse().map_err(|_| invalid())?;
    let format = if now.timestamp_subsec_micros() == 0 {
        "%Y-%m-%dT%H:%M:%S%:z"
    } else {
        "%Y-%m-%dT%H:%M:%S%.6f%:z"
    };
    Ok(
        json!({"source":"daily_summary_runtime_clock","utc":now.format(format).to_string(),"local":now.with_timezone(&zone).format(format).to_string(),"timezone":name}),
    )
}

pub struct Tool {
    pub settings: Settings,
    parser: Mutex<Option<std::sync::Arc<Parser>>>,
    environment: HashMap<String, String>,
}
impl Tool {
    pub fn new(raw: &Value, env: &HashMap<String, String>) -> Result<Self> {
        let settings = Settings::new(raw)?;
        let environment = env
            .iter()
            .filter(|(key, _)| {
                CONTRACT["allowed_environment"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == key.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Ok(Self {
            settings,
            parser: Mutex::new(None),
            environment,
        })
    }
    pub fn parser(&self) -> Result<std::sync::Arc<Parser>> {
        let mut cached = self.parser.lock().unwrap();
        if cached.is_none() {
            *cached = Some(std::sync::Arc::new(Parser::discover(Path::new(
                self.settings.values["skills_directory"].as_str().unwrap(),
            ))?));
        }
        Ok(cached.as_ref().unwrap().clone())
    }
    pub fn schema(&self, name: &str) -> Result<Value> {
        self.parser()?;
        self.settings.schema(name)
    }
    pub async fn call(&self, raw: &Value) -> Result<(String, Vec<String>)> {
        let parser = self.parser()?;
        let input = self.settings.arguments(raw)?;
        let name = trim(input["skill_name"].as_str().unwrap_or(""));
        match input["operation"].as_str().unwrap() {
            "list_skills" => Ok((parser.list(input["query"].as_str()), vec![])),
            "load_skill" => parser.load(name, input["resource"].as_str(), Utc::now()),
            _ => {
                let path = parser.contained(name, trim(input["script"].as_str().unwrap()), true);
                if input["script"].as_str().unwrap().contains('\0') {
                    return Err(Failure::new("ValueError").into());
                }
                match path {
                    Err(error) if error.downcast_ref::<Failure>().is_some() => Err(error),
                    Err(error) => Ok((format!("Error: {error}"), vec![])),
                    Ok(path) => Ok((
                        run_script(
                            &path,
                            &self.settings,
                            input["args"].as_str(),
                            &self.environment,
                        )
                        .await,
                        vec![],
                    )),
                }
            }
        }
    }
}

struct ProcessGroup(Option<u32>);
impl ProcessGroup {
    fn terminate(&mut self) {
        if let Some(id) = self.0.take() {
            // The child owns a new session/process group, including descendants.
            // No pointer is passed to libc; a missing group is already finished.
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn run_script(
    path: &Path,
    settings: &Settings,
    args: Option<&str>,
    env: &HashMap<String, String>,
) -> String {
    use std::{
        os::unix::process::ExitStatusExt,
        process::Stdio,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    use tokio::{
        io::{AsyncRead, AsyncReadExt},
        process::Command,
    };
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!(".{}", lower(s)))
        .unwrap_or_default();
    let extensions = &settings.values["allowed_script_extensions"];
    if !extensions
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e == &extension)
    {
        return format!(
            "Error: Extension '{}' is not allowed. Permitted: {}",
            extension,
            crate::profile_import::identifier(extensions)
        );
    }
    let program = match extension.as_str() {
        ".py" => "python3",
        ".sh" => "bash",
        _ => path.to_str().unwrap_or(""),
    };
    let mut command = Command::new(program);
    if [".py", ".sh"].contains(&extension.as_str()) {
        command.arg(path);
    }
    if let Some(args) = args {
        command.args(
            args.split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
                .filter(|s| !s.is_empty()),
        );
    }
    command
        .current_dir(path.parent().unwrap())
        .env_clear()
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // setsid is async-signal-safe and touches no Rust allocation in the child.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return format!("Error executing script: {}", os_error(&error, program)),
    };
    let mut group = ProcessGroup(child.id());
    let limit = CONTRACT["script_output_limit"].as_u64().unwrap() as usize;
    let remaining = AtomicUsize::new(limit);
    let stdout = Mutex::new(Vec::new());
    let stderr = Mutex::new(Vec::new());
    enum CaptureError {
        Limit,
        Io(std::io::Error),
    }
    async fn capture(
        mut stream: impl AsyncRead + Unpin,
        output: &Mutex<Vec<u8>>,
        remaining: &AtomicUsize,
    ) -> std::result::Result<(), CaptureError> {
        let mut buffer = vec![0; 65536];
        loop {
            let size = buffer
                .len()
                .min(remaining.load(Ordering::SeqCst).saturating_add(1));
            let count = stream
                .read(&mut buffer[..size])
                .await
                .map_err(CaptureError::Io)?;
            if count == 0 {
                return Ok(());
            }
            let before = remaining
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                    Some(n.saturating_sub(count))
                })
                .unwrap();
            let kept = before.min(count);
            output.lock().unwrap().extend_from_slice(&buffer[..kept]);
            if count > kept {
                return Err(CaptureError::Limit);
            }
        }
    }
    let timeout = settings.values["script_timeout"].as_u64().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(timeout), async {
        tokio::try_join!(
            capture(child.stdout.take().unwrap(), &stdout, &remaining),
            capture(child.stderr.take().unwrap(), &stderr, &remaining)
        )?;
        child.wait().await.map_err(CaptureError::Io)
    })
    .await;
    group.terminate();
    let status = child.wait().await.ok();
    let failure = match result {
        Err(_) => Some(format!("Error: Script timed out after {timeout}s")),
        Ok(Err(CaptureError::Limit)) => Some(format!(
            "Error: Script output limit exceeded ({limit} bytes combined); process group terminated."
        )),
        Ok(Err(CaptureError::Io(error))) => Some(format!("Error executing script: {error}")),
        Ok(Ok(_)) => None,
    };
    let stdout = stdout.into_inner().unwrap();
    let stderr = stderr.into_inner().unwrap();
    let mut parts = Vec::new();
    if !stdout.is_empty() {
        parts.push(String::from_utf8_lossy(&stdout).into_owned());
    }
    if !stderr.is_empty() {
        parts.push(format!("[stderr]\n{}", String::from_utf8_lossy(&stderr)));
    }
    if let Some(failure) = failure {
        parts.push(failure);
    } else if let Some(status) = status {
        let code = status
            .code()
            .unwrap_or_else(|| -status.signal().unwrap_or(1));
        if code != 0 {
            parts.push(format!("[exit code: {code}]"));
        }
    }
    if parts.is_empty() {
        "(no output)".into()
    } else {
        parts.join("\n")
    }
}

#[tokio::test]
#[ignore = "requires the retained tool image and real process fixture"]
async fn actual_processes() {
    let document: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("DAEDALUS_SKILLS_INPUT").unwrap()).unwrap(),
    )
    .unwrap();
    let mut observations = Vec::new();
    for case in document["cases"].as_array().unwrap() {
        let mut env: HashMap<String, String> =
            serde_json::from_value(document["environment"].clone()).unwrap();
        if let Some(fields) = case["env"].as_object() {
            env.extend(
                fields
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().into())),
            );
        }
        let tool = std::sync::Arc::new(Tool::new(&case["config"], &env).unwrap());
        let mut result;
        if case["cancel"] == true {
            let input = case["input"].clone();
            let invocation = tool.clone();
            let task = tokio::spawn(async move { invocation.call(&input).await });
            let ready = Path::new(case["ready"].as_str().unwrap());
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            while !ready.exists() {
                assert!(
                    !task.is_finished(),
                    "Skill stopped before the cancellation barrier"
                );
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "Skill never reached cancellation barrier"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            result = json!({"cancelled":true,"recovery":tool.call(&json!({"operation":"list_skills"})).await.unwrap().0,"loaded":[]});
        } else {
            result = match tool.call(&case["input"]).await {
                Ok((text, loaded)) => json!({"ok":text,"loaded":loaded}),
                Err(error) => {
                    json!({"error":error.downcast_ref::<Failure>().unwrap().class,"loaded":[]})
                }
            };
        }
        let path = Path::new(case["processes"].as_str().unwrap());
        result["processes_gone"] = Value::Null;
        if path.exists() {
            let record: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(record["parent"], record["group"]);
            assert_eq!(record["parent"], record["session"]);
            let pids = std::iter::once(&record["parent"])
                .chain(record["children"].as_array().unwrap())
                .map(|n| n.as_u64().unwrap())
                .collect::<Vec<_>>();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let live = pids.iter().any(|pid| {
                    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|text| {
                        text.rsplit_once(')').unwrap().1.split_whitespace().next() != Some("Z")
                    })
                });
                if !live {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "A script process survived completion or Stop"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            result["processes_gone"] = json!(true);
        }
        observations.push(json!({"name":case["name"],"result":result}));
        eprintln!("Native skill process: {}", case["name"]);
    }
    std::fs::write(
        std::env::var("DAEDALUS_SKILLS_OUTPUT").unwrap(),
        serde_json::to_vec_pretty(&observations).unwrap(),
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let mut value =
            serde_json::from_str(include_str!("../tests/fixtures/agent-skills.json")).unwrap();
        crate::document_codecs::tests::expand(&mut value);
        value
    }
    fn write(root: &Path, files: &Value) {
        for (name, value) in files.as_object().unwrap() {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let bytes = if let Some(text) = value.as_str() {
                text.as_bytes().to_vec()
            } else {
                let hex = value["hex"].as_str().unwrap();
                (0..hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                    .collect()
            };
            std::fs::write(path, bytes).unwrap();
        }
    }
    #[tokio::test]
    async fn retained_configuration_and_inputs() {
        let fixture = fixture();
        for case in fixture["configuration"].as_array().unwrap() {
            let actual = match Settings::new(&case["input"]) {
                Ok(settings) => {
                    let mut value = json!({"ok":settings.values});
                    match settings.schema("configured_skills") {
                        Ok(schema) => value["schema"] = schema,
                        Err(_) => value["schema_error"] = json!("ValueError"),
                    };
                    value
                }
                Err(_) => json!({"error":true}),
            };
            assert_eq!(actual, case["expected"], "configuration {}", case["input"]);
        }
        for case in fixture["inputs"].as_array().unwrap() {
            let mask = case["mask"].as_u64().unwrap() as usize;
            let operations = OPERATIONS
                .iter()
                .enumerate()
                .filter(|(index, _)| mask & (1 << index) != 0)
                .map(|(_, name)| name)
                .collect::<Vec<_>>();
            let tool = Tool::new(&json!({"skills_directory":"/synthetic-missing", "allow_script_execution":case["allow"], "enabled_operations":operations}), &HashMap::new()).unwrap();
            let actual = match tool.call(&case["input"]).await {
                Ok((text, _)) => json!({"ok":text}),
                Err(error) => {
                    let error = error.downcast_ref::<Failure>().unwrap();
                    let mut value = json!({"error":error.class});
                    if !error.validation.is_empty() {
                        value["validation"] = json!(error.validation);
                    }
                    value
                }
            };
            assert_eq!(
                actual, case["expected"],
                "input mask={mask} allow={} {}",
                case["allow"], case["input"]
            );
        }
    }
    #[test]
    fn resources_and_scripts_stay_inside_their_skill_directory() {
        let root =
            std::env::temp_dir().join(format!("daedalus-skill-escape-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("alpha")).unwrap();
        std::fs::create_dir_all(root.join("alpha-private")).unwrap();
        std::fs::write(
            root.join("alpha/SKILL.md"),
            "---\nname: alpha\ndescription: Synthetic skill.\n---\nBody\n",
        )
        .unwrap();
        std::fs::write(root.join("alpha-private/secret.sh"), "echo secret\n").unwrap();
        std::os::unix::fs::symlink("../alpha-private", root.join("alpha/sibling")).unwrap();
        let parser = Parser::discover(&root).unwrap();
        let absolute = root.join("alpha-private/secret.sh");
        // A sibling directory shares the skill directory's string prefix.
        for relative in [
            absolute.to_str().unwrap(),
            "../alpha-private/secret.sh",
            "sibling/secret.sh",
        ] {
            let (text, loaded) = parser
                .load(
                    "alpha",
                    Some(relative),
                    "2026-10-14T12:00:00Z".parse().unwrap(),
                )
                .unwrap();
            assert_eq!(
                text,
                format!("Error: Resource path escapes the skill directory: {relative}")
            );
            assert!(loaded.is_empty());
            let error = parser.contained("alpha", relative, true).unwrap_err();
            assert!(
                error.to_string().starts_with("Script path escapes"),
                "{error}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retained_parser_and_loading() {
        let fixture = fixture();
        let base =
            std::env::temp_dir().join(format!("daedalus-native-skills-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        for case in fixture["frontmatter"].as_array().unwrap() {
            std::fs::write(base.join("SKILL.md"), case["content"].as_str().unwrap()).unwrap();
            let raw = read(&base.join("SKILL.md")).unwrap();
            let actual = match frontmatter(&raw, &base) {
                Ok(metadata) => {
                    let value = metadata.value();
                    let parser = Parser {
                        skills: vec![metadata],
                        instructions: Mutex::new(HashMap::new()),
                    };
                    json!({"metadata":value,"body":parser.instructions(value["name"].as_str().unwrap()).unwrap()})
                }
                Err(_) => json!({"error":"ValueError"}),
            };
            assert_eq!(actual, case["expected"], "frontmatter {}", case["content"]);
        }
        for (index, case) in fixture["catalogs"].as_array().unwrap().iter().enumerate() {
            let root = base.join(format!("case-{index}/root"));
            std::fs::create_dir_all(&root).unwrap();
            write(&root, &case["files"]);
            if let Some(links) = case["links"].as_object() {
                for (name, target) in links {
                    std::os::unix::fs::symlink(target.as_str().unwrap(), root.join(name)).unwrap();
                }
            }
            let parser = Parser::discover(&root).unwrap();
            let metadata = parser
                .skills
                .iter()
                .map(Metadata::value)
                .collect::<Vec<_>>();
            let mut calls = Vec::new();
            for call in case["calls"].as_array().unwrap() {
                if call["write"].is_object() {
                    write(&root, &call["write"]);
                }
                if let Some(names) = call["delete"].as_array() {
                    for name in names {
                        std::fs::remove_file(root.join(name.as_str().unwrap())).unwrap();
                    }
                }
                let (output, loaded) = if call["operation"] == "list_skills" {
                    (parser.list(call["query"].as_str()), vec![])
                } else {
                    parser
                        .load(
                            call["skill_name"].as_str().unwrap(),
                            call["resource"].as_str(),
                            "2026-10-14T12:00:00.123456Z".parse().unwrap(),
                        )
                        .unwrap()
                };
                calls.push(json!({"output":output.replace(root.to_str().unwrap(), "{ROOT}"),"loaded":loaded}));
            }
            assert_eq!(
                json!({"metadata":metadata,"calls":calls}),
                case["expected"],
                "catalog {}",
                case["name"]
            );
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
