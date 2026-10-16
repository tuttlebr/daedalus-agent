//! Native indexing schemas and row payloads matching the pinned SDK.
use crate::{document_json::Surrogates, milvus_index_proto as pb, milvus_serialization};
use anyhow::{Result, bail};
use prost::Message;
use serde_json::{Value, json};

fn parameter(key: &str, value: impl ToString) -> pb::KeyValuePair {
    pb::KeyValuePair {
        key: key.into(),
        value: value.to_string(),
    }
}
pub fn schema(collection: &str, dimension: i64, metadata: bool) -> pb::CollectionSchema {
    let mut fields = vec![pb::FieldSchema {
        name: "pk".into(),
        data_type: 5,
        is_primary_key: true,
        auto_id: true,
        ..Default::default()
    }];
    let definitions = if metadata {
        vec![
            ("collection_name", 21),
            ("vector", 101),
            ("timestamp", 21),
            ("indexes", 23),
            ("models", 23),
            ("user_fields", 23),
        ]
    } else {
        vec![
            ("vector", 101),
            ("source", 23),
            ("content_metadata", 23),
            ("text", 21),
        ]
    };
    for (name, data_type) in definitions {
        let type_params = match data_type {
            101 => vec![parameter("dim", if metadata { 2 } else { dimension })],
            21 => vec![parameter("max_length", 65535)],
            _ => Vec::new(),
        };
        fields.push(pb::FieldSchema {
            name: name.into(),
            data_type,
            type_params,
            nullable: name == "content_metadata",
            ..Default::default()
        });
    }
    pb::CollectionSchema {
        name: collection.into(),
        auto_id: true,
        enable_dynamic_field: true,
        fields,
        ..Default::default()
    }
}
pub fn create_collection(
    collection: &str,
    dimension: i64,
    metadata: bool,
) -> pb::CreateCollectionRequest {
    pb::CreateCollectionRequest {
        collection_name: collection.into(),
        schema: schema(collection, dimension, metadata).encode_to_vec(),
        consistency_level: 2,
        ..Default::default()
    }
}
pub fn create_index(collection: &str, metadata: bool) -> pb::CreateIndexRequest {
    let mut params = if metadata {
        Vec::new()
    } else {
        vec![parameter("M", 64), parameter("efConstruction", 512)]
    };
    params.extend([
        parameter("metric_type", "L2"),
        parameter("index_type", if metadata { "FLAT" } else { "HNSW" }),
    ]);
    pb::CreateIndexRequest {
        collection_name: collection.into(),
        field_name: "vector".into(),
        index_name: "dense_index".into(),
        extra_params: params,
        ..Default::default()
    }
}
pub fn metadata_record(collection: &str, dimension: i64, timestamp: &str, model: &str) -> Value {
    json!({"collection_name":collection,"vector":[0.0,0.0],"timestamp":timestamp,
        "indexes":{"dense_index":"HNSW","dense_dimension":dimension,"sparse_index":"None"},
        "models":{"embedding_model":model,"embedding_dim":dimension,"sparse_model":null},
        "user_fields":["pk","vector","source","content_metadata","text"]})
}
pub fn insert(
    collection: &str,
    schema: &pb::CollectionSchema,
    rows: &[Value],
) -> Result<pb::InsertRequest> {
    insert_with_surrogates(collection, schema, rows, &Surrogates::new())
}
pub fn insert_with_surrogates(
    collection: &str,
    schema: &pb::CollectionSchema,
    rows: &[Value],
    surrogates: &Surrogates,
) -> Result<pb::InsertRequest> {
    use milvus_serialization::{kind, mismatch};
    use pb::{field_data::Field, scalar_field::Data};
    let mut input_fields: Vec<_> = schema
        .fields
        .iter()
        .filter(|f| !f.auto_id && !f.is_function_output)
        .collect();
    if let Some(primary) = schema.fields.iter().find(|f| f.is_primary_key && f.auto_id)
        && let Some(first) = rows.first()
    {
        if matches!(first, Value::Null | Value::Bool(_) | Value::Number(_)) {
            bail!("argument of type '{}' is not iterable", kind(first));
        }
        if first.get(&primary.name).is_some() {
            input_fields.push(primary);
        }
    }
    let positions: std::collections::HashMap<_, _> = input_fields
        .iter()
        .enumerate()
        .map(|(i, f)| (f.name.as_str(), i))
        .collect();
    let mut fields_data: Vec<_> = input_fields
        .iter()
        .map(|field| pb::FieldData {
            r#type: field.data_type,
            field_name: field.name.clone(),
            ..Default::default()
        })
        .collect();
    let mut dynamic_data = Vec::new();
    // Keep protobuf columns in schema order, but validate and append in the
    // SDK's row/key order. This also preserves which error wins over a missing
    // field or an invalid value in another row.
    for row in rows {
        let object = row.as_object().ok_or_else(|| {
            mismatch("The Input data type is inconsistent with defined schema, please check it.")
        })?;
        for (name, value) in object {
            if let Some(&position) = positions.get(name.as_str()) {
                pack(
                    input_fields[position],
                    value,
                    &mut fields_data[position],
                    surrogates,
                )?;
            } else if schema
                .fields
                .iter()
                .any(|f| f.name == *name && f.is_function_output)
            {
                return Err(mismatch(&format!(
                    "Attempt to insert an unexpected function output field `{name}` to collection"
                )));
            } else if !schema.enable_dynamic_field {
                return Err(mismatch(&format!(
                    "Attempt to insert an unexpected field `{name}` to collection without enabling dynamic field"
                )));
            } else if name == "$meta" {
                // The SDK reserves this synthetic column and accidentally tries
                // to read it as a schema dict if the caller supplies it.
                bail!("get");
            }
        }
        for (position, field) in input_fields.iter().enumerate() {
            if object.contains_key(&field.name) {
                continue;
            }
            if field.nullable || field.default_value.is_some() {
                pack(field, &Value::Null, &mut fields_data[position], surrogates)?;
            } else {
                return Err(mismatch(&format!(
                    "Insert missed an field `{}` to collection without set nullable==true or set default_value",
                    field.name
                )));
            }
        }
        if schema.enable_dynamic_field {
            let extras = object
                .iter()
                .filter(|(key, _)| !positions.contains_key(key.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            dynamic_data.push(milvus_serialization::dynamic(
                &Value::Object(extras),
                surrogates,
            )?);
        }
    }
    if schema.enable_dynamic_field {
        fields_data.push(pb::FieldData {
            r#type: 23,
            field_name: "$meta".into(),
            is_dynamic: true,
            field: (!rows.is_empty()).then_some(Field::Scalars(pb::ScalarField {
                data: Some(Data::JsonData(pb::JSONArray { data: dynamic_data })),
            })),
            ..Default::default()
        });
    }
    Ok(pb::InsertRequest {
        collection_name: collection.into(),
        fields_data,
        num_rows: rows.len().try_into()?,
        ..Default::default()
    })
}

fn pack(
    field: &pb::FieldSchema,
    value: &Value,
    output: &mut pb::FieldData,
    markers: &Surrogates,
) -> Result<()> {
    use milvus_serialization::{field_error, kind};
    use pb::{field_data::Field, scalar_field::Data, vector_field::Data as Vector};
    if field.nullable || field.default_value.is_some() {
        output.valid_data.push(!value.is_null());
    }
    // Even a null value sets the scalar oneof to an empty array. Empty batches
    // leave it unset; nullable vectors have a different presence convention.
    macro_rules! scalar {
        ($variant:ident, $array:ident, $expression:expr) => {{
            let data = output.field.get_or_insert_with(|| {
                Field::Scalars(pb::ScalarField {
                    data: Some(Data::$variant(pb::$array { data: Vec::new() })),
                })
            });
            let Field::Scalars(pb::ScalarField {
                data: Some(Data::$variant(array)),
            }) = data
            else {
                unreachable!()
            };
            if !value.is_null() {
                array.data.push($expression);
            }
        }};
    }
    match field.data_type {
        1 => scalar!(BoolData, BoolArray, {
            if let Value::Bool(b) = value {
                *b
            } else if kind(value) == "int" {
                value
                    .as_i64()
                    .ok_or_else(|| anyhow::anyhow!("Python int too large to convert to C long"))?
                    != 0
            } else {
                return Err(field_error(
                    &field.name,
                    "bool",
                    value,
                    &format!(
                        "'{}' object cannot be interpreted as an integer",
                        kind(value)
                    ),
                ));
            }
        }),
        2..=4 => scalar!(IntData, IntArray, integer(value, field, false)? as i32),
        5 => scalar!(LongData, LongArray, integer(value, field, true)?),
        10 => scalar!(
            FloatData,
            FloatArray,
            real(value, value, field, "float")? as f32
        ),
        11 => scalar!(
            DoubleData,
            DoubleArray,
            real(value, value, field, "double")?
        ),
        21 => scalar!(
            StringData,
            StringArray,
            milvus_serialization::varchar(value, field, markers)?
        ),
        23 => scalar!(
            JsonData,
            JSONArray,
            milvus_serialization::json_field(value, &field.name, markers)?
        ),
        101 => {
            let data = output
                .field
                .get_or_insert_with(|| Field::Vectors(pb::VectorField::default()));
            let Field::Vectors(vector) = data else {
                unreachable!()
            };
            if value.is_null() {
                if vector.dim == 0 {
                    vector.dim = field
                        .type_params
                        .iter()
                        .find(|p| p.key == "dim")
                        .and_then(|p| p.value.parse().ok())
                        .unwrap_or(0);
                }
            } else {
                let items: &[Value] = match value {
                    Value::Array(items) => items,
                    Value::String(text) if text.is_empty() => &[],
                    Value::Object(object) if object.is_empty() => &[],
                    Value::String(_) | Value::Object(_) => {
                        return Err(field_error(
                            &field.name,
                            "float_vector",
                            value,
                            "must be real number, not str",
                        ));
                    }
                    _ => {
                        return Err(field_error(
                            &field.name,
                            "float_vector",
                            value,
                            &format!("object of type '{}' has no len()", kind(value)),
                        ));
                    }
                };
                vector.dim = items.len() as i64;
                let data = vector
                    .data
                    .get_or_insert_with(|| Vector::FloatVector(pb::FloatArray::default()));
                let Vector::FloatVector(array) = data else {
                    unreachable!()
                };
                for item in items {
                    array
                        .data
                        .push(real(item, value, field, "float_vector")? as f32);
                }
            }
        }
        _ => bail!(
            "<ParamError: (code=1, message=Unsupported data type: {})>",
            field.data_type
        ),
    }
    Ok(())
}

fn integer(value: &Value, field: &pb::FieldSchema, long: bool) -> Result<i64> {
    use milvus_serialization::{field_error, kind};
    let expected = if long { "int64" } else { "int" };
    let detail = if value.is_boolean() {
        format!(
            "Field milvus.proto.schema.{}Array.data: Expected an int, got a boolean.",
            if long { "Long" } else { "Int" }
        )
    } else if kind(value) == "int" {
        if let Some(number) = value.as_i64()
            && (long || i32::try_from(number).is_ok())
        {
            return Ok(number);
        }
        format!("Value out of range: {value}")
    } else {
        format!(
            "'{}' object cannot be interpreted as an integer",
            kind(value)
        )
    };
    Err(field_error(&field.name, expected, value, &detail))
}

fn real(item: &Value, value: &Value, field: &pb::FieldSchema, expected: &str) -> Result<f64> {
    use milvus_serialization::{field_error, kind};
    match item {
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Number(n) => {
            let number = n.to_string().parse::<f64>()?;
            // CPython float conversion raises OverflowError for a huge integer,
            // which the SDK's TypeError/ValueError wrapper does not catch.
            if !number.is_finite() && kind(item) == "int" {
                bail!("int too large to convert to float");
            }
            Ok(number)
        }
        _ => Err(field_error(
            &field.name,
            expected,
            value,
            &format!("must be real number, not {}", kind(item)),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn retained_row_validation_and_scalar_packing() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-rows.json")).unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let mut failures = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            let (rows, markers) = crate::document_json::decode_indexed(
                case["rows_json"].as_str().unwrap().as_bytes(),
            )
            .unwrap();
            let wire = base64::engine::general_purpose::STANDARD
                .decode(case["schema"].as_str().unwrap())
                .unwrap();
            let schema = pb::CollectionSchema::decode(wire.as_slice()).unwrap();
            let result = insert_with_surrogates(
                "private_collection",
                &schema,
                rows.as_array().unwrap(),
                &markers,
            );
            if let Some(expected) = case["expected"]["base64"].as_str() {
                let expected = base64::engine::general_purpose::STANDARD
                    .decode(expected)
                    .unwrap();
                match result {
                    Ok(actual) if actual.encode_to_vec() == expected => {}
                    Ok(actual) => failures.push(format!(
                        "{}: different wire bytes\nactual {actual:?}\nexpected {:?}",
                        case["name"],
                        pb::InsertRequest::decode(expected.as_slice()).unwrap()
                    )),
                    Err(error) => failures.push(format!("{}: {error}", case["name"])),
                }
            } else {
                let actual = result
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "Unexpectedly accepted".into());
                if actual != case["expected"]["message"].as_str().unwrap() {
                    failures.push(format!(
                        "{}: {actual}\nexpected {}",
                        case["name"], case["expected"]["message"]
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
    #[test]
    fn retained_final_serialization_payloads_and_errors() {
        let mut fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-serialization.json"))
                .unwrap();
        crate::document_codecs::tests::expand(&mut fixture);
        let mut failures = Vec::new();
        for case in fixture["cases"].as_array().unwrap() {
            let (rows, markers) = crate::document_json::decode_indexed(
                case["rows_json"].as_str().unwrap().as_bytes(),
            )
            .unwrap_or_else(|| panic!("Unable to decode {}", case["name"]));
            let result = insert_with_surrogates(
                "private_collection",
                &schema("private_collection", 2, false),
                rows.as_array().unwrap(),
                &markers,
            );
            if let Some(expected) = case["expected"]["base64"].as_str() {
                let actual = match result {
                    Ok(actual) => actual,
                    Err(error) => {
                        failures.push(format!("{}: {error}", case["name"]));
                        continue;
                    }
                };
                let expected = base64::engine::general_purpose::STANDARD
                    .decode(expected)
                    .unwrap();
                if actual.encode_to_vec() != expected {
                    failures.push(format!("{}: serialized bytes differ", case["name"]));
                }
            } else {
                let actual = result
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "Unexpectedly accepted".into());
                if actual != case["expected"]["message"].as_str().unwrap() {
                    failures.push(format!(
                        "{}: {actual}\nexpected: {}",
                        case["name"], case["expected"]["message"]
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
    #[test]
    fn retained_creation_and_insert_payloads() {
        let mut data: Value =
            serde_json::from_str(include_str!("../tests/fixtures/milvus-index.json")).unwrap();
        crate::document_codecs::tests::expand(&mut data);
        for case in data["cases"].as_array().unwrap() {
            for call in case["calls"].as_array().unwrap() {
                let method = call["method"].as_str().unwrap();
                let Some(collection) = call["body"]["collection_name"].as_str() else {
                    continue;
                };
                let meta = collection == "meta";
                let actual = match method {
                    "CreateCollection" => create_collection(collection, 2, meta).encode_to_vec(),
                    "CreateIndex" => create_index(collection, meta).encode_to_vec(),
                    "Insert" => {
                        let records = if meta {
                            vec![metadata_record(
                                "private_collection",
                                2,
                                "2026-10-13 12:00:00",
                                "nvidia/llama-nemotron-embed-1b-v2",
                            )]
                        } else {
                            crate::document_index::records(&mut case["records"].clone()).unwrap()
                        };
                        insert(collection, &schema(collection, 2, meta), &records)
                            .unwrap()
                            .encode_to_vec()
                    }
                    _ => continue,
                };
                let expected = base64::engine::general_purpose::STANDARD
                    .decode(call["base64"].as_str().unwrap())
                    .unwrap();
                assert_eq!(actual, expected, "{method} {collection}");
            }
        }
        for case in data["payloads"].as_array().unwrap() {
            let actual = insert(
                "private_collection",
                &schema("private_collection", 2, false),
                case["rows"].as_array().unwrap(),
            );
            if let Some(encoded) = case["expected"]["base64"].as_str() {
                let expected = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap();
                assert_eq!(
                    actual
                        .unwrap_or_else(|e| panic!("{case}: {e}"))
                        .encode_to_vec(),
                    expected,
                    "{case}"
                );
            } else {
                assert!(actual.is_err(), "{case}");
            }
        }
    }
}
