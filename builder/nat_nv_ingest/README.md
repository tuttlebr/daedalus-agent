# NvIngest PDF Processing Tool

This NAT tool integrates PDF document processing capabilities into your chatbot workflow, allowing users to upload PDFs that are automatically processed and indexed for retrieval.

## Features

- **PDF Upload Support**: Users can upload PDF documents via the attachment icon in the chat interface
- **Redis Storage**: PDFs are temporarily stored in Redis for processing
- **NvIngest Integration**: Uses NVIDIA's NvIngest service to extract text from PDFs
- **Milvus Vector Storage**: Processed text is chunked, embedded, and stored in Milvus for retrieval
- **User-Specific Collections**: Each user's documents are stored in their own Milvus collection

## Configuration

The tool configuration is defined in `src/nv_ingest/configs/config.yml`:

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

1. **Upload a PDF**: Click the attachment icon in the chat interface and select a PDF file
2. **Process the PDF**: The assistant will automatically detect the PDF and can process it using the `process_pdf` function
3. **Query your documents**: Once processed, the PDF content is searchable in your personal knowledge base

### Example Interaction

```
User: [Uploads technical_manual.pdf]
Assistant: I see you've uploaded a PDF file. Would you like me to process and index this document?

User: Yes, please process it
Assistant: ✅ Successfully processed PDF 'technical_manual.pdf'
- Extracted and indexed 45 text chunks
- Stored in your personal collection 'john_doe'
- Chunk size: 1024 characters with 150 overlap

The document is now searchable in your knowledge base!
```

## Technical Details

- **Max PDF Size**: 10MB
- **Storage Duration**: PDFs are stored in Redis for 7 days
- **Processing**: Text extraction only (tables, charts, and images are not extracted)
- **Chunking**: Documents are split into overlapping chunks for better retrieval

## Dependencies

- `nv-ingest~=2025.10` (latest 2025.10.x version)
- `nv-ingest-client~=2025.10` (latest 2025.10.x version)
- `redis`
- `pymilvus>=2.3.0`
