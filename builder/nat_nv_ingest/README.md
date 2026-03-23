# NvIngest PDF Processing Tool

This NVIDIA NeMo Agent toolkit function integrates PDF document processing capabilities into your chatbot workflow, allowing users to upload single or multiple PDFs that are automatically processed and indexed for retrieval.

## Features

The function provides the following features:
- **Single and Multiple PDF Support**: Users can upload one or multiple PDF documents through the *Attachment* icon
- **Batch Processing**: Process multiple PDFs in a single operation, all stored in the same collection
- **Redis Storage**: PDFs are temporarily stored in Redis for processing
- **NvIngest Integration**: Uses NVIDIA's NvIngest service to extract text from PDFs
- **Milvus Vector Storage**: Processed text is chunked, embedded, and stored in Milvus for retrieval
- **Collection Selection**: Users can choose which Milvus collection to store their documents in
- **Collection Listing**: View all available Milvus collections before uploading

## Configuration

The tool configuration is defined in `src/nat_nv_ingest/configs/config.yml`:

```yaml
functions:
  nv_ingest:
    _type: nv_ingest
    redis_url: "redis://daedalus-redis.daedalus.svc.cluster.local:6379"
    nv_ingest_host: "192.168.1.239"
    nv_ingest_port: 7670
    milvus_uri: "http://192.168.1.234:32073"
    minio_endpoint: "192.168.1.239:9000"
    chunk_size: 1024
    chunk_overlap: 150
    embedder_dim: 2048
    recreate_collection: true
```

## Usage

### Single PDF Upload
Use these steps to upload a single PDF:
1. **Upload a PDF**: Click the *Attachment* icon in the chat interface and select a PDF file
2. **Choose a Collection**: The assistant can list available collections and let you choose where to store the document
3. **Process the PDF**: The assistant will process it using the `process_pdf` function with your chosen collection
4. **Query your documents**: Once processed, the PDF content is searchable in the specified collection

### Multiple PDF Upload
Use these steps to upload multiple PDFs:
1. **Upload Multiple PDFs**: Click the *Attachment* icon and select multiple PDF files at once
2. **Choose a Collection**: Select one collection where all PDFs will be stored
3. **Batch Processing**: The assistant will process all PDFs in sequence
4. **Summary Report**: Receive a detailed summary of the batch processing results

### Example Interactions

#### Single PDF
```
User: [Uploads technical_manual.pdf]
Assistant: I see you've uploaded a PDF file. Would you like me to process and index this document?

User: What collections are available?
Assistant: Here are the available Milvus collections:
- john_doe (your personal collection)
- shared_docs
- engineering_team
- product_specs

User: Please process it and store it in the engineering_team collection
Assistant: ✅ Successfully processed PDF 'technical_manual.pdf'
- Extracted and indexed 45 text chunks
- Stored in collection 'engineering_team'
- Chunk size: 1024 characters with 150 overlap

The document is now searchable in the engineering_team knowledge base!
```

#### Multiple PDFs
```
User: [Uploads design_spec.pdf, user_guide.pdf, api_reference.pdf]
Assistant: I see you've uploaded 3 PDF files. Would you like me to process and index all these documents?

User: Yes, please store them all in the engineering_team collection
Assistant: ✅ Successfully processed all 3 PDFs

📄 Summary:
- Total PDFs: 3
- Total chunks indexed: 142
- Collection: 'engineering_team'
- Chunk size: 1024 with 150 overlap

📋 Processed files:
- design_spec.pdf (35 chunks)
- user_guide.pdf (62 chunks)
- api_reference.pdf (45 chunks)

All documents are now searchable in your knowledge base!
```

## Technical Details

The following technical details apply:
- **Max PDF Size**: 10 MB per file
- **Batch Processing**: Support for processing multiple PDFs in a single operation
  - **Batch Size Limit**: Maximum 5 PDFs per batch to avoid processing timeouts
  - For larger sets of documents, process them in multiple batches
- **Storage Duration**: PDFs are stored in Redis for seven days
- **Processing**: Text extraction with support for tables and charts (images are not extracted)
- **Chunking**: Documents are split into overlapping chunks for better retrieval
- **Collection Management**:
  - Default collection name is the user's username if not specified
  - The `list_collections` function shows all available Milvus collections
  - Users can specify any existing collection for document storage
  - When processing multiple PDFs, all documents are stored in the same collection

## Dependencies

The function depends on the following packages:
- `nv-ingest~=2025.10` (latest 2025.10.x version)
- `nv-ingest-client~=2025.10` (latest 2025.10.x version)
- `redis`
- `pymilvus>=2.3.0`
