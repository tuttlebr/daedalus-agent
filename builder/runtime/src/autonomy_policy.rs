//! Task-scoped capability limits for the autonomous charter. Model notes cannot
//! broaden this policy, and generic shell/delegation tools cannot bypass it.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub max_tool_calls: usize,
}
impl Task {
    pub fn parse(body: &Value, autonomy: bool) -> Result<Option<Self>> {
        let Some(value) = body.get("autonomy_task").filter(|value| !value.is_null()) else {
            return Ok(None);
        };
        let task: Self = serde_json::from_value(value.clone())?;
        if !autonomy
            || task.id.is_empty()
            || task.id.len() > 160
            || !(5..=100).contains(&task.max_tool_calls)
            || ![
                "calendar_discovery",
                "calendar_event",
                "sports_discovery",
                "game_lighting",
                "cluster_maintenance",
                "evolution",
            ]
            .contains(&task.kind.as_str())
        {
            bail!("Invalid autonomous charter task");
        }
        Ok(Some(task))
    }

    pub fn mutation(name: &str, args: &Value) -> bool {
        if name == "k8s_mcp_server__execInPod" && safe_http_probe(args) {
            return false;
        }
        name == "add_memory"
            || name.split_once("__").is_some_and(|(group, tool)| {
                crate::authorization::mutating(tool, args, &Value::Null)
                    || (group == "hue_mcp_server"
                        && ["activate_scene", "recall_scene"].contains(&tool))
            })
    }

    pub fn verification_group(name: &str, args: &Value) -> Option<String> {
        if name == "get_memory" {
            return Some("memory".into());
        }
        if Self::backup_read(name, args).is_some() {
            return Some("k8s_mcp_server".into());
        }
        if name == "k8s_mcp_server__execInPod" && safe_http_probe(args) {
            return Some("k8s_mcp_server".into());
        }
        let (group, tool) = name.split_once("__")?;
        if tool == "connect" || Self::mutation(name, args) {
            return None;
        }
        let lower = tool.to_ascii_lowercase();
        ["get", "list", "search", "describe"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
            .then(|| group.to_owned())
    }

    pub fn backup_target(name: &str, args: &Value) -> Option<(String, String)> {
        if name != "k8s_mcp_server__runKubectlCommand" {
            return None;
        }
        let target = backup_target(args)?;
        let tokens = command_tokens(args)?;
        let options = command_options(&tokens[3..])?;
        let location = object_identity(
            "configmap",
            &tokens[2],
            options.get("--namespace")?,
            options.get("--context")?,
        );
        Some((target, location))
    }

    pub fn backup_read(name: &str, args: &Value) -> Option<String> {
        (name == "k8s_mcp_server__runKubectlCommand")
            .then(|| backup_read(args))
            .flatten()
    }

    pub fn patch_target(name: &str, args: &Value) -> Option<String> {
        if name != "k8s_mcp_server__runKubectlCommand" || !safe_kubectl(args) {
            return None;
        }
        let tokens = command_tokens(args)?;
        if tokens.first()?.as_str() != "patch" {
            return None;
        }
        let options = command_options(&tokens[3..])?;
        Some(object_identity(
            &tokens[1],
            &tokens[2],
            options.get("--namespace")?,
            options.get("--context")?,
        ))
    }

    pub fn allows(&self, name: &str, args: &Value) -> bool {
        if name == crate::autonomy_output::TOOL {
            return true;
        }
        if name == "agent_skills_tool" {
            return matches!(
                args["operation"].as_str(),
                Some("list_skills" | "load_skill")
            );
        }
        let Some((group, tool)) = name.split_once("__") else {
            return [
                "current_datetime_tool",
                "get_memory",
                "add_memory",
                "domain_retriever_tool",
                "curated_feed_search_tool",
                "tool_output_retriever_tool",
                "perplexity_search_tool",
                "webscrape_tool",
                "nws_weather_tool",
                "nvidia_docs_tool",
                "source_verifier_tool",
            ]
            .contains(&name);
        };
        if tool == "connect" {
            return true;
        }
        if group == "k8s_mcp_server" {
            if tool == "execInPod" {
                return self.kind == "cluster_maintenance" && safe_http_probe(args);
            }
            if tool == "runKubectlCommand" {
                return self.kind == "cluster_maintenance" && safe_kubectl(args);
            }
            if [
                "devopsAgent",
                "helmInstall",
                "helmUpgrade",
                "helmRollback",
                "helmUninstall",
                "helmRepoAdd",
                "scaleResource",
                "remediateGPUIssue",
            ]
            .contains(&tool)
            {
                return false;
            }
            if tool == "rolloutRestart" {
                return self.kind == "cluster_maintenance";
            }
            if tool == "deleteResource" {
                let kinds: Vec<_> = ["kind", "resourceType", "resource", "type"]
                    .iter()
                    .filter_map(|field| args.get(*field))
                    .collect();
                return self.kind == "cluster_maintenance"
                    && !kinds.is_empty()
                    && kinds.iter().all(|kind| {
                        kind.as_str().is_some_and(|kind| {
                            matches!(kind.to_ascii_lowercase().as_str(), "pod" | "pods")
                        })
                    });
            }
            // Full resource application can change images or operator versions.
            // Configuration/resource-limit repairs use the constrained patch path.
            if ["createResource", "createResourceYAML"].contains(&tool) {
                return false;
            }
            if ["helmList", "helmGet", "helmHistory", "helmRepoList"].contains(&tool) {
                return true;
            }
        }
        if group == "calendar_mcp_server" && ["create_event", "update_event"].contains(&tool) {
            return self.kind == "calendar_event";
        }
        if group == "hue_mcp_server"
            && ["set_light_state", "activate_scene", "recall_scene"].contains(&tool)
        {
            return self.kind == "game_lighting";
        }
        let lower = tool.to_ascii_lowercase();
        [
            "get",
            "list",
            "search",
            "describe",
            "validate",
            "diagnose",
            "suggest_time",
            "account_status",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
            && !crate::authorization::mutating(tool, args, &Value::Null)
    }
}

/// Tokenize a deliberately small command language. There is no interpolation,
/// shell chaining, redirection, escaping or newline execution in this surface.
fn words(command: &str) -> Option<Vec<String>> {
    let mut quote = None;
    let mut words = Vec::new();
    let mut word = String::new();
    for c in command.chars() {
        if matches!(c, '\n' | '\r' | '\0') || (quote != Some('\'') && matches!(c, '$' | '`' | '\\'))
        {
            return None;
        }
        if let Some(delimiter) = quote {
            if c == delimiter {
                quote = None;
            } else {
                word.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
        } else if matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')') {
            return None;
        } else if c.is_whitespace() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if quote.is_some() {
        return None;
    }
    if !word.is_empty() {
        words.push(word);
    }
    Some(words)
}

/// Permit an application health GET, not a shell or an arbitrary in-pod program.
/// Timeouts and output are bounded; no uploads, credentials, redirects or writes.
fn safe_http_probe(args: &Value) -> bool {
    let command = &args["command"];
    let tokens = if let Some(command) = command.as_str() {
        words(command)
    } else {
        command.as_array().and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect()
        })
    };
    let Some(tokens) = tokens else {
        return false;
    };
    if tokens.len() != 7
        || tokens[..6]
            != [
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
            ]
    {
        return false;
    }
    if tokens[6].chars().any(|c| {
        c.is_whitespace()
            || matches!(
                c,
                ';' | '|' | '&' | '<' | '>' | '$' | '`' | '\\' | '\'' | '"' | '(' | ')'
            )
    }) {
        return false;
    }
    reqwest::Url::parse(&tokens[6]).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

const BACKUP_PREFIX: &str = "daedalus-autonomy-backup-";

fn command_tokens(args: &Value) -> Option<Vec<String>> {
    // The context and namespace must be part of the inspected command, not an
    // out-of-band server override that could invalidate backup binding.
    if !only(args, &["command"]) {
        return None;
    }
    let mut tokens = words(args["command"].as_str()?)?;
    if tokens.first().is_some_and(|word| word == "kubectl") {
        tokens.remove(0);
    }
    Some(tokens)
}

fn command_options(tokens: &[String]) -> Option<std::collections::BTreeMap<String, String>> {
    let mut options = std::collections::BTreeMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let (flag, inline) = tokens[index]
            .split_once('=')
            .map_or((tokens[index].as_str(), None), |(key, value)| {
                (key, Some(value))
            });
        let flag = match flag {
            "-n" => "--namespace",
            "-p" => "--patch",
            "-o" => "--output",
            other => other,
        };
        let value = if let Some(value) = inline {
            value
        } else {
            index += 1;
            tokens.get(index)?.as_str()
        };
        if value.is_empty() || options.insert(flag.to_owned(), value.to_owned()).is_some() {
            return None;
        }
        index += 1;
    }
    Some(options)
}

fn object_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.starts_with(|c: char| c.is_ascii_alphanumeric())
                && label.ends_with(|c: char| c.is_ascii_alphanumeric())
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

fn object_identity(kind: &str, name: &str, namespace: &str, context: &str) -> String {
    serde_json::json!([
        context,
        namespace,
        kind.to_ascii_lowercase().trim_end_matches('s'),
        name
    ])
    .to_string()
}

/// A backup is a new, uniquely named ConfigMap in the source object's namespace.
/// Its JSON data is inert; it cannot create a workload, update software or execute
/// code. Only the supported maintenance targets may be captured here.
fn backup_target(args: &Value) -> Option<String> {
    let tokens = command_tokens(args)?;
    if tokens.len() < 5
        || tokens[0] != "create"
        || tokens[1] != "configmap"
        || !tokens[2].starts_with(BACKUP_PREFIX)
        || tokens[2].len() <= BACKUP_PREFIX.len()
        || tokens[2].len() > 63
        || !object_name(&tokens[2])
    {
        return None;
    }
    let options = command_options(&tokens[3..])?;
    if options
        .keys()
        .any(|flag| !["--from-literal", "--namespace", "--context"].contains(&flag.as_str()))
    {
        return None;
    }
    let raw = options.get("--from-literal")?.strip_prefix("snapshot=")?;
    if raw.len() > 262144 {
        return None;
    }
    let snapshot: Value = serde_json::from_str(raw).ok()?;
    let kind = snapshot["kind"].as_str()?;
    if !["ConfigMap", "Deployment", "StatefulSet", "DaemonSet", "Pod"].contains(&kind) {
        return None;
    }
    let name = snapshot["metadata"]["name"].as_str()?;
    let namespace = snapshot["metadata"]["namespace"].as_str()?;
    if !object_name(name)
        || name.starts_with(BACKUP_PREFIX)
        || !object_name(namespace)
        || options.get("--namespace").map(String::as_str) != Some(namespace)
        || snapshot["apiVersion"].as_str().is_none_or(str::is_empty)
    {
        return None;
    }
    Some(object_identity(
        kind,
        name,
        namespace,
        options.get("--context")?,
    ))
}

fn backup_read(args: &Value) -> Option<String> {
    let tokens = command_tokens(args)?;
    if tokens.len() < 5
        || tokens[0] != "get"
        || tokens[1] != "configmap"
        || !tokens[2].starts_with(BACKUP_PREFIX)
        || !object_name(&tokens[2])
    {
        return None;
    }
    let options = command_options(&tokens[3..])?;
    if options
        .keys()
        .any(|flag| !["--output", "--namespace", "--context"].contains(&flag.as_str()))
        || options.get("--output").map(String::as_str) != Some("json")
    {
        return None;
    }
    let namespace = options.get("--namespace")?;
    if !object_name(namespace) {
        return None;
    }
    Some(object_identity(
        "configmap",
        &tokens[2],
        namespace,
        options.get("--context")?,
    ))
}

fn safe_kubectl(args: &Value) -> bool {
    if backup_target(args).is_some() || backup_read(args).is_some() {
        return true;
    }
    let Some(tokens) = command_tokens(args) else {
        return false;
    };
    // Read commands use structured tools. Repairs patch one named object;
    // backup ConfigMaps above are the only permitted creation path.
    if tokens.len() < 5 || tokens[0] != "patch" {
        return false;
    }
    let resource = tokens[1].to_lowercase();
    if ![
        "deployment",
        "deployments",
        "statefulset",
        "statefulsets",
        "daemonset",
        "daemonsets",
        "configmap",
        "configmaps",
    ]
    .contains(&resource.as_str())
        || !object_name(&tokens[2])
        || tokens[2].starts_with(BACKUP_PREFIX)
    {
        return false;
    }
    let Some(options) = command_options(&tokens[3..]) else {
        return false;
    };
    if options
        .keys()
        .any(|flag| !["--type", "--patch", "--namespace", "--context"].contains(&flag.as_str()))
    {
        return false;
    }
    if options
        .get("--namespace")
        .is_none_or(|namespace| !object_name(namespace))
        || !options.contains_key("--context")
    {
        return false;
    }
    let patch_type = options.get("--type").map(String::as_str);
    let Some(patch) = options
        .get("--patch")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    else {
        return false;
    };
    if resource.starts_with("configmap") {
        return patch_type == Some("merge")
            && only(&patch, &["data"])
            && patch["data"]
                .as_object()
                .is_some_and(|data| !data.is_empty() && data.values().all(Value::is_string));
    }
    // Strategic merge keeps unmentioned containers and their images intact.
    patch_type == Some("strategic")
        && only(&patch, &["spec"])
        && only(&patch["spec"], &["template"])
        && only(&patch["spec"]["template"], &["spec"])
        && only(&patch["spec"]["template"]["spec"], &["containers"])
        && patch["spec"]["template"]["spec"]["containers"]
            .as_array()
            .is_some_and(|containers| {
                !containers.is_empty()
                    && containers.iter().all(|container| {
                        only(container, &["name", "resources"])
                            && container["name"]
                                .as_str()
                                .is_some_and(|name| !name.is_empty())
                            && only(&container["resources"], &["requests", "limits"])
                            && container["resources"].as_object().is_some_and(|resources| {
                                resources.values().all(|values| {
                                    values.as_object().is_some_and(|values| {
                                        !values.is_empty() && values.values().all(Value::is_string)
                                    })
                                })
                            })
                    })
            })
}
fn only(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        !object.is_empty() && object.keys().all(|key| keys.contains(&key.as_str()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn task(kind: &str) -> Task {
        Task {
            id: "action:one".into(),
            kind: kind.into(),
            max_tool_calls: 20,
        }
    }
    #[test]
    fn permissions_follow_the_task_not_external_text() {
        assert!(task("calendar_event").allows("calendar_mcp_server__create_event", &json!({})));
        assert!(
            !task("calendar_discovery").allows("calendar_mcp_server__create_event", &json!({}))
        );
        assert!(!task("cluster_maintenance").allows("hue_mcp_server__set_light_state", &json!({})));
        assert!(task("game_lighting").allows("hue_mcp_server__set_light_state", &json!({})));
        assert!(!task("game_lighting").allows("hue_mcp_server__create_schedule", &json!({})));
        assert!(!task("evolution").allows("llm_sandbox_tool", &json!({})));
        assert!(
            task("cluster_maintenance")
                .allows("agent_skills_tool", &json!({"operation":"load_skill"}))
        );
        assert!(!task("cluster_maintenance").allows(
            "agent_skills_tool",
            &json!({"operation":"run_skill_script"})
        ));
    }
    #[test]
    fn upgrades_and_shell_bypasses_are_rejected() {
        let policy = task("cluster_maintenance");
        for name in [
            "helmUpgrade",
            "helmInstall",
            "helmRollback",
            "execInPod",
            "devopsAgent",
            "createResourceYAML",
        ] {
            assert!(!policy.allows(&format!("k8s_mcp_server__{name}"), &json!({})));
        }
        for command in [
            "kubectl set image deployment/app app=new:v2",
            "kubectl get pods; helm upgrade app",
            "kubectl patch configmap app -n home --context=house --type=merge -p='{}' $(touch /tmp/x)",
        ] {
            assert!(!policy.allows(
                "k8s_mcp_server__runKubectlCommand",
                &json!({"command": command})
            ));
        }
        assert!(policy.allows("k8s_mcp_server__rolloutRestart", &json!({"name":"app"})));
        assert!(policy.allows("k8s_mcp_server__deleteResource", &json!({"kind":"Pod"})));
        assert!(!policy.allows(
            "k8s_mcp_server__deleteResource",
            &json!({"kind":"PersistentVolumeClaim"})
        ));
        assert!(!policy.allows(
            "k8s_mcp_server__deleteResource",
            &json!({"kind":"Pod", "resourceType":"PersistentVolumeClaim"})
        ));
        assert!(!policy.allows(
            "k8s_mcp_server__deleteResource",
            &json!({"kind":"Pod", "resource":null})
        ));
    }
    #[test]
    fn config_patch_has_no_shell_or_version_capability() {
        assert!(safe_kubectl(
            &json!({"command": "kubectl patch configmap app -n home --context=house --type=merge -p='{\"data\":{\"timeout\":\"30\"}}'"})
        ));
        assert!(!safe_kubectl(
            &json!({"command": "kubectl patch deployment app --type=merge -p='{\"spec\":{\"template\":{\"spec\":{\"containers\":[{\"image\":\"new:v2\"}]}}}}'"})
        ));
    }
    #[test]
    fn resource_patch_preserves_images_and_container_list() {
        let command = r#"kubectl patch deployment app -n home --context=house --type=strategic -p='{"spec":{"template":{"spec":{"containers":[{"name":"app","resources":{"requests":{"cpu":"100m"},"limits":{"memory":"512Mi"}}}]}}}}'"#;
        assert!(safe_kubectl(&json!({"command":command})));
        for unsafe_command in [
            command.replace("--type=strategic", "--type=merge"),
            command.replace("\"name\":\"app\"", "\"image\":\"new:v2\""),
            command.replace("\"resources\":", "\"image\":\"new:v2\",\"resources\":"),
            command.replace("--context=house", ""),
            command.replace("-n home", ""),
        ] {
            assert!(!safe_kubectl(&json!({"command":unsafe_command})));
        }
    }

    #[test]
    fn task_cannot_be_enabled_by_interactive_request_or_unknown_kind() {
        assert!(Task::parse(&json!({"autonomy_task":{"id":"one","kind":"cluster_maintenance","max_tool_calls":20}}), false).is_err());
        assert!(
            Task::parse(
                &json!({"autonomy_task":{"id":"one","kind":"shell","max_tool_calls":20}}),
                true
            )
            .is_err()
        );
    }

    #[test]
    fn verification_requires_a_read_of_the_mutated_service() {
        assert_eq!(
            Task::verification_group("k8s_mcp_server__getResource", &json!({})),
            Some("k8s_mcp_server".into())
        );
        assert_eq!(
            Task::verification_group("k8s_mcp_server__connect", &json!({})),
            None
        );
        assert_eq!(
            Task::verification_group("k8s_mcp_server__getResource", &json!({"action":"delete"})),
            None
        );
        assert_eq!(
            Task::verification_group("current_datetime_tool", &json!({})),
            None
        );
    }

    #[test]
    fn cluster_backup_is_inert_bound_to_source_and_cannot_be_overwritten() {
        let command = r#"kubectl create configmap daedalus-autonomy-backup-one -n home --from-literal='snapshot={"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"app","namespace":"home"},"data":{"nested":"{\"timeout\":30}"}}' --context=house"#;
        let args = json!({"command":command});
        let policy = task("cluster_maintenance");
        assert!(policy.allows("k8s_mcp_server__runKubectlCommand", &args));
        let (target, backup) =
            Task::backup_target("k8s_mcp_server__runKubectlCommand", &args).unwrap();
        let patch = json!({"command": r#"kubectl patch configmap app -n home --context=house --type=merge -p='{"data":{"timeout":"30"}}'"#});
        assert_eq!(
            Task::patch_target("k8s_mcp_server__runKubectlCommand", &patch),
            Some(target)
        );
        let read = json!({"command":"kubectl get configmap daedalus-autonomy-backup-one -n home --context=house -o json"});
        assert_eq!(
            Task::backup_read("k8s_mcp_server__runKubectlCommand", &read),
            Some(backup)
        );
        for command in [
            command.replace("-n home", "-n other"),
            command.replace("\"kind\":\"ConfigMap\"", "\"kind\":\"Secret\""),
            command.replace("daedalus-autonomy-backup-one", "regular-object"),
            format!("{command}; helm upgrade app"),
            r#"kubectl patch configmap daedalus-autonomy-backup-one --type=merge -p='{"data":{"snapshot":"changed"}}'"#.into(),
        ] {
            assert!(!safe_kubectl(&json!({"command":command})), "{command}");
        }
    }

    #[test]
    fn application_probe_cannot_be_a_shell_or_a_write() {
        let name = "k8s_mcp_server__execInPod";
        let args = json!({"command":["curl","--fail","--silent","--show-error","--max-time","10","http://127.0.0.1:8080/health"]});
        assert!(task("cluster_maintenance").allows(name, &args));
        assert!(!Task::mutation(name, &args));
        assert_eq!(
            Task::verification_group(name, &args),
            Some("k8s_mcp_server".into())
        );
        for command in [
            json!(["sh", "-c", "helm upgrade app"]),
            json!(
                "curl --fail --silent --show-error --max-time 10 http://app/health; helm upgrade app"
            ),
            json!("curl --fail --silent --show-error --max-time 10 file:///etc/passwd"),
            json!("curl --fail --silent --show-error --max-time 10 -XPOST"),
            json!([
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "10",
                "http://app/;touch /tmp/bypass"
            ]),
        ] {
            assert!(!task("cluster_maintenance").allows(name, &json!({"command":command})));
        }
    }
}
