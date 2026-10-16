//! Dense search wire contracts for the native document retriever.
use crate::{config::truthy, milvus_index_proto as pb, profile_import::identifier};
#[cfg(test)]
use base64::Engine;
use prost::Message;
use serde_json::{Map, Value, json};

/// The flag identifies failures inside the SDK call. Lazy result decoding
/// happens afterward and must not invalidate the retriever's metadata caches.
#[derive(Debug)]
pub struct Failure(pub &'static str, pub bool);
impl Failure {
    fn in_call(mut self) -> Self {
        self.1 = true;
        self
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Document retrieval failed ({})", self.0)
    }
}
impl std::error::Error for Failure {}
type Result<T> = std::result::Result<T, Failure>;
fn parameter() -> Failure {
    Failure("ParamError", true)
}
fn invalid() -> Failure {
    Failure("MilvusException", false)
}

impl crate::milvus::Status for pb::SearchResults {
    fn status(&self) -> Option<&crate::milvus_proto::Status> {
        self.status.as_ref()
    }
}
pub async fn search(
    client: &mut crate::milvus::Client,
    request: pb::SearchRequest,
) -> Result<Vec<Vec<Hit>>> {
    use crate::milvus::ReadFailure;
    // The pinned SDK applies its retry decorator twice to Search. Exhaustion
    // reconstructs MilvusException without the legacy compatible code, so only
    // modern rate limits enter this second cycle. Other reads have one layer.
    let mut backoff = std::time::Duration::from_millis(10);
    for attempt in 0..=75 {
        match client.call("Search", request.clone(), true, false).await {
            Ok(response) => return decode(response),
            Err(error) => match error.downcast_ref::<ReadFailure>() {
                Some(ReadFailure::RateLimitExhausted) if attempt < 75 => {
                    client.retry_sleep(backoff).await;
                    backoff = (backoff * 3).min(std::time::Duration::from_secs(3));
                }
                Some(
                    ReadFailure::Application
                    | ReadFailure::RateLimitExhausted
                    | ReadFailure::Exhausted,
                ) => {
                    return Err(invalid().in_call());
                }
                _ => return Err(Failure("_InactiveRpcError", true)),
            },
        }
    }
    unreachable!("last exhausted attempt returns an error")
}

/// The timestamp belongs to the SDK's endpoint/database/collection mutation
/// cache. A read with no prior acknowledged mutation uses one.
pub fn request(args: &Value, vectors: &[Vec<f64>], timestamp: u64) -> Result<pb::SearchRequest> {
    request_inner(args, vectors, timestamp).map_err(Failure::in_call)
}
fn request_inner(args: &Value, vectors: &[Vec<f64>], timestamp: u64) -> Result<pb::SearchRequest> {
    let limit = &args["limit"];
    if !(limit == &json!(true)
        || limit.is_number()
            && !limit.to_string().contains(['.', 'e', 'E'])
            && limit != &json!(0)
            && !limit.to_string().starts_with('-'))
    {
        return Err(parameter());
    }
    let output_fields = if args["output_fields"].is_null() {
        Vec::new()
    } else {
        args["output_fields"]
            .as_array()
            .ok_or_else(parameter)?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(parameter))
            .collect::<Result<Vec<_>>>()?
    };
    let vector = if truthy(&args["anns_field"]) {
        args["anns_field"].as_str().ok_or_else(parameter)?
    } else {
        ""
    };
    let empty = Map::new();
    let raw = if truthy(&args["search_params"]) {
        args["search_params"].as_object().ok_or_else(invalid)?
    } else {
        &empty
    };
    let mut params = match raw.get("params") {
        Some(value) => value.as_object().cloned().ok_or_else(parameter)?,
        None => Map::new(),
    };
    if let Some(value) = raw.get("page_retain_order").filter(|v| !v.is_null()) {
        if !value.is_boolean() {
            return Err(parameter());
        }
        params.insert("page_retain_order".into(), value.clone());
    }
    for (key, value) in raw {
        if let Some(existing) = params.get(key) {
            if existing != value {
                return Err(parameter());
            }
        } else if key != "params" {
            params.insert(key.clone(), value.clone());
        }
    }
    let mut options = vec![
        ("topk", limit.clone()),
        ("round_decimal", json!(-1)),
        (
            "ignore_growing",
            raw.get("ignore_growing")
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or(json!(false)),
        ),
    ];
    if let Some(value) = raw.get("offset").filter(|v| !v.is_null()) {
        if !(value.is_boolean()
            || value.is_number() && !value.to_string().contains(['.', 'e', 'E']))
        {
            return Err(parameter());
        }
        options.push(("offset", value.clone()));
    }
    if let Some(value) = raw.get("metric_type").filter(|v| !v.is_null()) {
        options.push(("metric_type", value.clone()));
    }
    if !vector.is_empty() {
        options.push(("anns_field", json!(vector)));
    }
    for name in ["hints", "analyzer_name"] {
        if let Some(value) = raw.get(name).filter(|v| !v.is_null()) {
            options.push((name, value.clone()));
        }
    }
    options.push(("params", Value::Object(params)));
    let search_params = options
        .into_iter()
        .map(|(key, value)| {
            let value = if value.is_object() {
                crate::milvus_serialization::search_json(&value).map_err(|_| invalid())?
            } else {
                identifier(&value)
            };
            Ok(pb::KeyValuePair {
                key: key.into(),
                value,
            })
        })
        .collect::<Result<_>>()?;
    let group = pb::PlaceholderGroup {
        placeholders: vec![pb::PlaceholderValue {
            tag: "$0".into(),
            r#type: if vectors.iter().all(Vec::is_empty) {
                104
            } else {
                101
            },
            values: vectors
                .iter()
                .map(|v| v.iter().flat_map(|n| (*n as f32).to_le_bytes()).collect())
                .collect(),
        }],
    };
    Ok(pb::SearchRequest {
        collection_name: args["collection_name"].as_str().ok_or_else(invalid)?.into(),
        dsl: if args["filter"].is_null() {
            String::new()
        } else {
            args["filter"].as_str().ok_or_else(invalid)?.into()
        },
        dsl_type: 1,
        output_fields,
        search_params,
        guarantee_timestamp: timestamp,
        nq: vectors.len() as i64,
        use_default_consistency: true,
        search_input: Some(pb::search_request::SearchInput::PlaceholderGroup(
            group.encode_to_vec(),
        )),
        ..Default::default()
    })
}

/// Preserve bytes, NumPy scalars and non-finite values through document
/// formatting, including the Document representation used for empty content.
#[derive(Clone, Debug)]
pub enum Field {
    Json(Value),
    Float(f64),
    Bytes(Vec<u8>),
    Array(Vec<Field>),
    Object(Vec<(String, Field)>),
    Sparse(Vec<(u32, f64)>),
    Numpy(&'static str, Box<Field>),
}
impl Field {
    #[cfg(test)]
    fn observation(&self) -> Value {
        match self {
            Self::Json(value) => value.clone(),
            Self::Float(n) if n.is_nan() => json!({"$float":"nan"}),
            Self::Float(n) if *n == f64::INFINITY => json!({"$float":"inf"}),
            Self::Float(n) if *n == f64::NEG_INFINITY => json!({"$float":"-inf"}),
            Self::Float(n) => json!(n),
            Self::Bytes(value) => {
                json!({"$bytes":base64::engine::general_purpose::STANDARD.encode(value)})
            }
            Self::Array(value) => json!(value.iter().map(Self::observation).collect::<Vec<_>>()),
            Self::Object(values) => Value::Object(
                values
                    .iter()
                    .map(|(k, v)| (k.clone(), v.observation()))
                    .collect(),
            ),
            Self::Sparse(values) => Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.to_string(), Self::Float(*value).observation()))
                    .collect(),
            ),
            Self::Numpy(dtype, value) => json!({"$numpy":dtype,"value":value.observation()}),
        }
    }
}
#[derive(Debug)]
pub struct Hit {
    #[cfg(test)]
    pub primary: String,
    #[cfg(test)]
    pub id: Value,
    pub distance: f64,
    pub entity: Vec<(String, Field)>,
}
impl Hit {
    #[cfg(test)]
    fn observation(&self) -> Value {
        let mut out = Map::new();
        out.insert(self.primary.clone(), self.id.clone());
        out.insert("distance".into(), Field::Float(self.distance).observation());
        out.insert(
            "entity".into(),
            Value::Object(
                self.entity
                    .iter()
                    .map(|(k, v)| (k.clone(), v.observation()))
                    .collect(),
            ),
        );
        Value::Object(out)
    }
    fn insert(&mut self, name: &str, value: Field) {
        if let Some((_, old)) = self.entity.iter_mut().find(|(k, _)| k == name) {
            *old = value;
        } else {
            self.entity.push((name.into(), value));
        }
    }
}
fn scalars(field: &pb::FieldData) -> pb::ScalarField {
    match &field.field {
        Some(pb::field_data::Field::Scalars(value)) => value.clone(),
        _ => pb::ScalarField::default(),
    }
}
fn scalar_values(scalar: &pb::ScalarField, kind: i32) -> Vec<Field> {
    use pb::scalar_field::Data;
    match (kind, &scalar.data) {
        (1, Some(Data::BoolData(v))) => v.data.iter().map(|v| Field::Json(json!(v))).collect(),
        (2..=4, Some(Data::IntData(v))) => v.data.iter().map(|v| Field::Json(json!(v))).collect(),
        (5, Some(Data::LongData(v))) => v.data.iter().map(|v| Field::Json(json!(v))).collect(),
        (10, Some(Data::FloatData(v))) => {
            v.data.iter().map(|v| Field::Float(f64::from(*v))).collect()
        }
        (11, Some(Data::DoubleData(v))) => v.data.iter().map(|v| Field::Float(*v)).collect(),
        (20 | 21 | 26, Some(Data::StringData(v))) => {
            v.data.iter().map(|v| Field::Json(json!(v))).collect()
        }
        (24, Some(Data::GeometryWktData(v))) => {
            v.data.iter().map(|v| Field::Json(json!(v))).collect()
        }
        _ => Vec::new(),
    }
}
fn vector(field: &pb::FieldData, index: usize) -> Result<Field> {
    let default = pb::VectorField::default();
    let vector = match &field.field {
        Some(pb::field_data::Field::Vectors(value)) => value,
        _ => &default,
    };
    let physical = if field.valid_data.is_empty() || field.r#type == 106 {
        index
    } else {
        if !*field
            .valid_data
            .get(index)
            .ok_or(Failure("IndexError", false))?
        {
            return Ok(Field::Json(Value::Null));
        }
        field.valid_data[..index].iter().filter(|v| **v).count()
    };
    let dim = usize::try_from(vector.dim).map_err(|_| invalid())?;
    match (field.r#type, &vector.data) {
        (104, Some(pb::vector_field::Data::SparseFloatVector(values))) => {
            let bytes = values
                .contents
                .get(physical)
                .ok_or(Failure("IndexError", false))?;
            if bytes.len() % 8 != 0 {
                return Err(Failure("error", false));
            }
            let mut values: Vec<(u32, f64)> = Vec::new();
            for pair in bytes.chunks_exact(8) {
                let key = u32::from_le_bytes(pair[..4].try_into().unwrap());
                let value = f64::from(f32::from_le_bytes(pair[4..].try_into().unwrap()));
                if let Some((_, old)) = values.iter_mut().find(|(k, _)| k == &key) {
                    *old = value;
                } else {
                    values.push((key, value));
                }
            }
            Ok(Field::Sparse(values))
        }
        (106, Some(pb::vector_field::Data::VectorArray(values))) => {
            let Some(row) = values.data.get(index) else {
                return Ok(Field::Array(Vec::new()));
            };
            let dimension = usize::try_from(row.dim).map_err(|_| invalid())?;
            if dimension == 0 {
                return Err(Failure("ZeroDivisionError", false));
            }
            let values = match &row.data {
                Some(pb::vector_field::Data::FloatVector(values)) => values.data.as_slice(),
                _ => &[],
            };
            Ok(Field::Array(
                values
                    .chunks_exact(dimension)
                    .map(|v| Field::Array(v.iter().map(|n| Field::Float(f64::from(*n))).collect()))
                    .collect(),
            ))
        }
        (101, Some(pb::vector_field::Data::FloatVector(values))) => Ok(Field::Array(
            values
                .data
                .iter()
                .skip(physical.saturating_mul(dim))
                .take(dim)
                .map(|n| Field::Float(f64::from(*n)))
                .collect(),
        )),
        (100, Some(pb::vector_field::Data::BinaryVector(values))) => Ok(Field::Bytes(
            values
                .iter()
                .skip(physical.saturating_mul(dim / 8))
                .take(dim / 8)
                .copied()
                .collect(),
        )),
        (102, Some(pb::vector_field::Data::Float16Vector(values)))
        | (103, Some(pb::vector_field::Data::Bfloat16Vector(values))) => Ok(Field::Bytes(
            values
                .iter()
                .skip(physical.saturating_mul(dim).saturating_mul(2))
                .take(dim.saturating_mul(2))
                .copied()
                .collect(),
        )),
        (105, Some(pb::vector_field::Data::Int8Vector(values))) => Ok(Field::Bytes(
            values
                .iter()
                .skip(physical.saturating_mul(dim))
                .take(dim)
                .copied()
                .collect(),
        )),
        // Missing oneof messages expose empty protobuf defaults in Python.
        (101 | 106, _) => Ok(Field::Array(Vec::new())),
        (100 | 102 | 103 | 105, _) => Ok(Field::Bytes(Vec::new())),
        (104, _) => Err(Failure("IndexError", false)),
        _ => Err(Failure("MilvusException", false)),
    }
}

pub(super) fn half(value: u16) -> f64 {
    let sign = if value & 0x8000 == 0 { 1.0 } else { -1.0 };
    let exponent = (value >> 10) & 31;
    let fraction = value & 1023;
    sign * match exponent {
        0 => f64::from(fraction) * 2f64.powi(-24),
        31 if fraction == 0 => f64::INFINITY,
        31 => f64::NAN,
        _ => (1.0 + f64::from(fraction) / 1024.) * 2f64.powi(i32::from(exponent) - 15),
    }
}
fn struct_column(field: &pb::FieldData, row: usize) -> Result<Option<Vec<Field>>> {
    if field.r#type == 22 {
        let scalar = scalars(field);
        let Some(pb::scalar_field::Data::ArrayData(array)) = scalar.data else {
            return Ok(None);
        };
        let Some(item) = array.data.get(row) else {
            return Ok(None);
        };
        let kind = match item.data {
            Some(pb::scalar_field::Data::BoolData(_)) => 1,
            Some(pb::scalar_field::Data::IntData(_)) => 4,
            Some(pb::scalar_field::Data::LongData(_)) => 5,
            Some(pb::scalar_field::Data::FloatData(_)) => 10,
            Some(pb::scalar_field::Data::DoubleData(_)) => 11,
            Some(pb::scalar_field::Data::StringData(_)) => 21,
            _ => 0,
        };
        return Ok(Some(scalar_values(item, kind)));
    }
    if field.r#type != 106 {
        return Err(parameter());
    }
    let Some(pb::field_data::Field::Vectors(vectors)) = &field.field else {
        return Ok(None);
    };
    let Some(pb::vector_field::Data::VectorArray(array)) = &vectors.data else {
        return Ok(None);
    };
    let Some(value) = array.data.get(row) else {
        return Ok(None);
    };
    let dim = usize::try_from(value.dim).map_err(|_| invalid())?;
    let width = match array.element_type {
        100 => dim / 8,
        102 | 103 => dim.saturating_mul(2),
        _ => dim,
    };
    if width == 0 {
        return Err(Failure("ZeroDivisionError", false));
    }
    let items = match (&value.data, array.element_type) {
        (Some(pb::vector_field::Data::FloatVector(values)), 101) => values
            .data
            .chunks_exact(dim)
            .map(|row| Field::Array(row.iter().map(|n| Field::Float(f64::from(*n))).collect()))
            .collect(),
        (Some(pb::vector_field::Data::Float16Vector(values)), 102) => values
            .chunks_exact(width)
            .map(|row| {
                Field::Array(
                    row.chunks_exact(2)
                        .map(|v| {
                            Field::Numpy(
                                "float16",
                                Box::new(Field::Float(half(u16::from_le_bytes(
                                    v.try_into().unwrap(),
                                )))),
                            )
                        })
                        .collect(),
                )
            })
            .collect(),
        (Some(pb::vector_field::Data::Bfloat16Vector(values)), 103) => values
            .chunks_exact(width)
            .map(|row| {
                Field::Array(
                    row.chunks_exact(2)
                        .map(|v| {
                            Field::Numpy(
                                "uint16",
                                Box::new(Field::Json(json!(u16::from_le_bytes(
                                    v.try_into().unwrap()
                                )))),
                            )
                        })
                        .collect(),
                )
            })
            .collect(),
        (Some(pb::vector_field::Data::Int8Vector(values)), 105) => values
            .chunks_exact(width)
            .map(|row| {
                Field::Array(
                    row.iter()
                        .map(|v| Field::Numpy("int8", Box::new(Field::Json(json!(*v as i8)))))
                        .collect(),
                )
            })
            .collect(),
        (Some(pb::vector_field::Data::BinaryVector(values)), 100) => values
            .chunks_exact(width)
            .map(|row| Field::Array(vec![Field::Bytes(row.to_vec())]))
            .collect(),
        _ => Vec::new(),
    };
    Ok(Some(items))
}
fn structs(field: &pb::FieldData, row: usize) -> Result<Field> {
    let Some(pb::field_data::Field::StructArrays(array)) = &field.field else {
        return Ok(Field::Array(Vec::new()));
    };
    let mut count = 0;
    // Only recognized columns determine the row count. Other kinds fail when
    // extracting a nonempty struct, matching the SDK's two-pass conversion.
    for column in array.fields.iter().filter(|v| matches!(v.r#type, 22 | 106)) {
        count = struct_column(column, row)?.map_or(0, |v| v.len());
        if count > 0 {
            break;
        }
    }
    let mut rows = (0..count).map(|_| Vec::new()).collect::<Vec<_>>();
    if count > 0 {
        for column in &array.fields {
            if let Some(values) = struct_column(column, row)? {
                for (i, fields) in rows.iter_mut().enumerate() {
                    fields.push((
                        column.field_name.clone(),
                        values.get(i).cloned().unwrap_or(Field::Json(Value::Null)),
                    ));
                }
            }
        }
    }
    Ok(Field::Array(rows.into_iter().map(Field::Object).collect()))
}
fn json_field(raw: &[u8]) -> Result<Value> {
    let invalid = || Failure("JSONDecodeError", false);
    let mut value = crate::document_json::parse_indexed(raw).ok_or_else(invalid)?;
    let mut pending = vec![&mut value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(number) => {
                // orjson retains signed/unsigned 64-bit integers and decodes
                // larger numeric tokens as finite double-precision values.
                if let Some(integer) = number.as_i64() {
                    *number = integer.into();
                } else if let Some(integer) = number.as_u64() {
                    *number = integer.into();
                } else {
                    *number = serde_json::Number::from_f64(number.as_f64().ok_or_else(invalid)?)
                        .ok_or_else(invalid)?;
                }
            }
            Value::Array(values) => pending.extend(values.iter_mut()),
            Value::Object(values) => pending.extend(values.values_mut()),
            _ => {}
        }
    }
    Ok(value)
}

pub fn decode(response: pb::SearchResults) -> Result<Vec<Vec<Hit>>> {
    if response
        .status
        .as_ref()
        .is_some_and(|s| s.code != 0 || s.error_code != 0)
    {
        return Err(invalid().in_call());
    }
    let data = response.results.unwrap_or_default();
    let ids = match data.ids.and_then(|v| v.id_field) {
        Some(pb::i_ds::IdField::IntId(v)) => {
            v.data.into_iter().map(|v| json!(v)).collect::<Vec<_>>()
        }
        Some(pb::i_ds::IdField::StrId(v)) => v.data.into_iter().map(|v| json!(v)).collect(),
        None => Vec::new(),
    };
    let dynamic = data
        .output_fields
        .iter()
        .filter(|name| !data.fields_data.iter().any(|f| &f.field_name == *name))
        .collect::<Vec<_>>();
    let mut results = Vec::new();
    let mut start = 0usize;
    for topk in data.topks {
        let count = usize::try_from(topk).map_err(|_| invalid().in_call())?;
        let end = start
            .checked_add(count)
            .ok_or_else(|| invalid().in_call())?;
        if end > ids.len() || end > data.scores.len() {
            return Err(invalid().in_call());
        }
        let mut hits = (start..end)
            .map(|i| Hit {
                #[cfg(test)]
                primary: if data.primary_field_name.is_empty() {
                    "id"
                } else {
                    &data.primary_field_name
                }
                .into(),
                #[cfg(test)]
                id: ids[i].clone(),
                distance: f64::from(data.scores[i]),
                entity: Vec::new(),
            })
            .collect::<Vec<_>>();
        // The SDK constructs scalar columns before lazily materializing vectors
        // and JSON. Dynamic keys can therefore overwrite ordinary columns.
        for field in &data.fields_data {
            let scalar = scalars(field);
            let values = match field.r#type {
                1..=5 | 10 | 11 | 21 | 24 | 26 => scalar_values(&scalar, field.r#type),
                22 => match &scalar.data {
                    Some(pb::scalar_field::Data::ArrayData(array))
                        if matches!(array.element_type, 1..=5 | 10 | 11 | 20 | 21) =>
                    {
                        array
                            .data
                            .iter()
                            .map(|v| Field::Array(scalar_values(v, array.element_type)))
                            .collect()
                    }
                    _ => Vec::new(),
                },
                23 | 100..=106 | 200 => continue,
                _ => return Err(invalid().in_call()),
            };
            for (row, value) in values.into_iter().enumerate().skip(start).take(count) {
                if !field.valid_data.is_empty() && row >= field.valid_data.len() {
                    break;
                }
                let value = if field.valid_data.get(row) == Some(&false) {
                    Field::Json(Value::Null)
                } else {
                    value
                };
                hits[row - start].insert(&field.field_name, value);
            }
        }
        for field in &data.fields_data {
            for (offset, hit) in hits.iter_mut().enumerate() {
                let index = start + offset;
                if field.r#type == 23 {
                    if field.valid_data.get(index) == Some(&false) {
                        hit.insert(&field.field_name, Field::Json(Value::Null));
                        continue;
                    }
                    let scalar = scalars(field);
                    let bytes = match &scalar.data {
                        Some(pb::scalar_field::Data::JsonData(v)) => v.data.get(index),
                        _ => None,
                    }
                    .ok_or(Failure("IndexError", false))?;
                    let value = json_field(bytes)?;
                    if !field.is_dynamic {
                        hit.insert(&field.field_name, Field::Json(value));
                    } else {
                        let object = value.as_object().ok_or(Failure("AttributeError", false))?;
                        for (key, value) in object {
                            if dynamic.is_empty() || dynamic.contains(&key) {
                                hit.insert(key, Field::Json(value.clone()));
                            }
                        }
                    }
                } else if matches!(field.r#type, 100..=106) {
                    hit.insert(&field.field_name, vector(field, index)?);
                } else if field.r#type == 200 {
                    hit.insert(&field.field_name, structs(field, index)?);
                }
            }
        }
        start = end;
        results.push(hits);
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vectors(args: &Value) -> Vec<Vec<f64>> {
        args["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|n| {
                        n.as_f64()
                            .unwrap_or_else(|| n["$float"].as_str().unwrap().parse().unwrap())
                    })
                    .collect()
            })
            .collect()
    }
    fn observation(result: Result<Vec<Vec<Hit>>>) -> Value {
        result.map(|v|json!({"ok":v.iter().map(|hits|hits.iter().map(Hit::observation).collect::<Vec<_>>()).collect::<Vec<_>>()}))
            .unwrap_or_else(|e|json!({"error":e.0}))
    }
    #[test]
    fn retained_search_wire_and_decoding() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-search.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for case in fixture["cases"].as_array().unwrap() {
            let actual = request(&case["arguments"], &vectors(&case["arguments"]), 1);
            let call = case["calls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["method"] == "Search");
            if let Some(call) = call {
                let wire = base64::engine::general_purpose::STANDARD
                    .decode(call["base64"].as_str().unwrap())
                    .unwrap();
                let expected = pb::SearchRequest::decode(wire.as_slice()).unwrap();
                assert_eq!(actual.unwrap(), expected, "request {}", case["name"]);
                if let Some(reply) = case["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find_map(|c| c["response_base64"].as_str())
                {
                    let wire = base64::engine::general_purpose::STANDARD
                        .decode(reply)
                        .unwrap();
                    let decoded = decode(pb::SearchResults::decode(wire.as_slice()).unwrap());
                    assert_eq!(
                        observation(decoded),
                        case["expected"],
                        "response {}",
                        case["name"]
                    );
                }
            } else {
                assert_eq!(
                    json!({"error":actual.unwrap_err().0}),
                    case["expected"],
                    "request {}",
                    case["name"]
                );
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires the disposable retained-SDK gRPC peer; run milvus_search_check.py"]
    async fn actual_grpc_search() {
        let control = std::env::var("DAEDALUS_SEARCH_PEER_CONTROL").unwrap();
        let uri = std::env::var("DAEDALUS_SEARCH_PEER_URI").unwrap();
        let all = std::env::var("DAEDALUS_SEARCH_PEER_CASES").unwrap() == "all";
        let gzip = std::env::var("DAEDALUS_SEARCH_PEER_GZIP").unwrap() == "true";
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-search.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            if !all && index > 0 {
                break;
            }
            let script = case["calls"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|call| !call["response_base64"].is_null())
                .cloned()
                .collect::<Vec<_>>();
            let mut reset = json!({"script":script,"uri":uri,"gzip":gzip});
            if case["fault"].get("grpc").is_some() {
                reset["faults"] = json!({"Search":case["fault"]});
            }
            http.post(format!("{control}/reset"))
                .json(&reset)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = crate::milvus_index_transport::tests::configured(&uri);
            let mut client = crate::milvus::Client::for_tool(
                &config,
                &json!({"uri":uri,"token":"synthetic-search-token"}),
            )
            .await
            .unwrap();
            let result = match request(&case["arguments"], &vectors(&case["arguments"]), 1) {
                Ok(request) => search(&mut client, request).await,
                Err(error) => Err(error),
            };
            assert_eq!(observation(result), case["expected"], "{}", case["name"]);
            let state: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                state,
                json!({"remaining":0,"errors":[]}),
                "{}",
                case["name"]
            );
            let calls: Vec<Value> = http
                .get(format!("{control}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Connect").count(),
                1,
                "{}",
                case["name"]
            );
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Search").count(),
                case["calls"].as_array().unwrap().len(),
                "{}",
                case["name"]
            );
            assert!(
                calls
                    .iter()
                    .all(|c| c["deadline"] == false && c["cancelled"] == false),
                "{}",
                case["name"]
            );
            println!("Native Milvus search: {}", case["name"]);
        }
    }

    #[tokio::test]
    #[ignore = "requires the disposable retained-SDK gRPC peer; run milvus_search_check.py"]
    async fn actual_grpc_search_retries() {
        let control = std::env::var("DAEDALUS_SEARCH_PEER_CONTROL").unwrap();
        let uri = std::env::var("DAEDALUS_SEARCH_PEER_URI").unwrap();
        let http = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-search-retries.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let retry = json!({"request":case["request"],"failures":case["failures"],"legacy":case["legacy"],"grpc":case["grpc"]});
            http.post(format!("{control}/reset"))
                .json(&json!({"uri":uri,"search_retry":retry}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            let config = crate::milvus_index_transport::tests::configured(&uri);
            let mut client = crate::milvus::Client::for_tool(&config, &json!({"uri":uri}))
                .await
                .unwrap();
            let sleeps = client.record_retry_sleeps();
            let wire = base64::engine::general_purpose::STANDARD
                .decode(case["request"].as_str().unwrap())
                .unwrap();
            let request = pb::SearchRequest::decode(wire.as_slice()).unwrap();
            let outcome = match search(&mut client, request).await {
                Ok(result) => {
                    assert_eq!(observation(Ok(result)), json!({"ok":[[]]}));
                    "success"
                }
                Err(error) => error.0,
            };
            assert_eq!(
                outcome,
                case["outcome"].as_str().unwrap(),
                "retry case {index}"
            );
            assert_eq!(
                json!(*sleeps.lock().unwrap()),
                case["sleep_ms"],
                "retry sleeps {index}"
            );
            let state: Value = http
                .get(format!("{control}/script"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                state,
                json!({"remaining":0,"errors":[]}),
                "retry case {index}"
            );
            let calls: Vec<Value> = http
                .get(format!("{control}/calls"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Search").count(),
                case["calls"].as_u64().unwrap() as usize,
                "retry case {index}"
            );
            assert_eq!(
                calls.iter().filter(|c| c["method"] == "Connect").count(),
                1,
                "retry case {index}"
            );
            assert!(
                calls
                    .iter()
                    .all(|c| c["deadline"] == false && c["cancelled"] == false),
                "retry case {index}"
            );
            println!("Native search exhaustion {index}: {} RPCs", case["calls"]);
        }
    }
}
