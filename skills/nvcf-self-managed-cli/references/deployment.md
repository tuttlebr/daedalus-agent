# Deployment Reference

Detailed reference for managing function deployments via `nvcf-cli`.

## Creating Deployments

### From JSON file

```bash
nvcf-cli function deploy create --input-file deploy.json
```

JSON deployment specification:

```json
{
  "deploymentSpecifications": [
    {
      "gpu": "H100",
      "instanceType": "NCP.GPU.H100_1x",
      "minInstances": 1,
      "maxInstances": 1
    }
  ]
}
```

The `--input-file` approach is recommended for complex deployments. You can also run `nvcf-cli function deploy --input-file deploy.json` (without the `create` subcommand).

### From CLI flags

```bash
nvcf-cli function deploy create \
  --function-id <id> \
  --version-id <version> \
  --gpu <gpu-type> \
  --instance-type <instance-type> \
  --min-instances <min> \
  --max-instances <max> \
  [--max-request-concurrency <concurrency>] \
  [--backend <backend>] \
  [--clusters <cluster1,cluster2>] \
  [--regions <region1,region2>] \
  [--availability-zones <az1,az2>] \
  [--attributes <attr1,attr2>] \
  [--preferred-order <int>] \
  [--timeout <seconds>] \
  [--cpu-arch <arch>] \
  [--driver-version <version>] \
  [--gpu-memory <memory>] \
  [--os <os>] \
  [--storage <storage>] \
  [--system-memory <memory>]
```

If `--function-id` and `--version-id` are omitted, the CLI uses the saved state from `function create`. If state was not persisted (check for warnings during `create`), you must pass both IDs explicitly.

### Required Fields

| Field | Flag | JSON Key | Default | Description |
|-------|------|----------|---------|-------------|
| GPU | `--gpu` | `gpu` | `H100` | GPU type |
| Instance Type | `--instance-type` | `instanceType` | `NCP.GPU.H100_1x` | Instance type |
| Min Instances | `--min-instances` | `minInstances` | `1` | Minimum number of instances |
| Max Instances | `--max-instances` | `maxInstances` | `1` | Maximum number of instances |

### Optional Fields

| Field | Flag | JSON Key | Description |
|-------|------|----------|-------------|
| Concurrency | `--max-request-concurrency` | `maxRequestConcurrency` | Max concurrent requests per instance (1-1024) |
| Backend | `--backend` | `backend` | Cloud provider / backend |
| Clusters | `--clusters` | `clusters` | Specific clusters to deploy to |
| Regions | `--regions` | `regions` | Allowed regions |
| Availability Zones | `--availability-zones` | `availabilityZones` | Availability zones within cluster group |
| Attributes | `--attributes` | `attributes` | Specific attribute capabilities |
| Preferred Order | `--preferred-order` | `preferredOrder` | Deployment priority for multi-spec |
| Timeout | `--timeout` | N/A | Deployment timeout in seconds (default: 900) |
| Cluster Name | `--cluster-name` | `clusterName` | Legacy cluster name (default: `GFN`, prefer `--backend`) |

### Hardware Specification Fields

| Field | Flag | Description |
|-------|------|-------------|
| CPU Architecture | `--cpu-arch` | CPU architecture details |
| Driver Version | `--driver-version` | GPU driver version |
| GPU Memory | `--gpu-memory` | Amount of GPU memory |
| OS | `--os` | Operating system details |
| Storage | `--storage` | Available storage (e.g., `80G`) |
| System Memory | `--system-memory` | Amount of RAM |

### Multi-Spec Deployments

Deploy across multiple GPU types or regions with preferred ordering:

```json
{
  "deploymentSpecifications": [
    {
      "gpu": "H100",
      "instanceType": "NCP.GPU.H100_1x",
      "minInstances": 1,
      "maxInstances": 2,
      "preferredOrder": 1
    },
    {
      "gpu": "A100",
      "instanceType": "NCP.GPU.A100_1x",
      "minInstances": 0,
      "maxInstances": 1,
      "preferredOrder": 2
    }
  ]
}
```

## Getting Deployment Details

```bash
nvcf-cli function deploy get --function-id <id> --version-id <version>

# JSON output
nvcf-cli function deploy get --function-id <id> --version-id <version> --json
```

Returns deployment status, GPU specifications, instance configurations, scaling parameters, health information, and timestamps.

## Updating Deployments

Modify an existing deployment's scaling parameters:

```bash
nvcf-cli function deploy update \
  --function-id <id> \
  --version-id <version> \
  --gpu <gpu-type> \
  --instance-type <instance-type> \
  --min-instances <min> \
  --max-instances <max> \
  [--max-request-concurrency <concurrency>] \
  [--clusters <cluster1,cluster2>] \
  [--availability-zones <az1,az2>] \
  [--preferred-order <int>]
```

GPU type and instance type must match the original deployment values. Backend configurations cannot be modified through update.

You can also use `--input-file` for updates.

## Removing Deployments

Remove a deployment, stopping all running instances. The function definition remains and can be redeployed later.

```bash
# Remove using saved state
nvcf-cli function deploy remove

# Remove specific deployment
nvcf-cli function deploy remove --function-id <id> --version-id <version>
```

Alternatively, use `nvcf-cli function delete --deployment-only` (with optional `--graceful` flag).

## Discovering Available GPUs

On self-managed clusters, available GPUs depend on the physical hardware in the cluster. Use `kubectl` to discover GPU nodes and their NVCA instance type labels:

```bash
kubectl get nodes -o custom-columns='NAME:.metadata.name,GPU_COUNT:.status.capacity.nvidia\.com/gpu,GPU_PRODUCT:.metadata.labels.nvidia\.com/gpu\.product'
```

To see the exact NVCA instance type label used for deployment scheduling:

```bash
kubectl get nodes -l nvidia.com/gpu.product -o custom-columns='NAME:.metadata.name,INSTANCE_TYPE:.metadata.labels.nvca\.nvcf\.nvidia\.io/instance-type'
```

The `nvca.nvcf.nvidia.io/instance-type` label on each node determines which `--instance-type` values are valid for deployment. Use these values when creating deployments.

## GPU and Instance Types

Common GPU types and instance type formats:

| GPU | Instance Type Example | Description |
|-----|----------------------|-------------|
| `H100` | `NCP.GPU.H100_1x` | NVIDIA H100, large-scale workloads |
| `A100` | `NCP.GPU.A100_1x` | NVIDIA A100, training and inference |
| `A10G` | `NCP.GPU.A10G_1x` | NVIDIA A10G, cost-effective inference |
| `L40S` | `NCP.GPU.L40S_1x` | NVIDIA L40S, enhanced inference |
| `L40` | `NCP.GPU.L40_1x` | NVIDIA L40, inference and light training |

Instance type naming convention: `NCP.GPU.<GPU_TYPE>_<count>x` where `<count>` is the number of GPUs allocated to each function instance. For example, `NCP.GPU.H100_1x` allocates 1 H100 GPU, while `NCP.GPU.H100_4x` allocates 4 H100 GPUs.

For multi-node deployments, append `.x<nodes>` (e.g., `NCP.GPU.H100_8x.x4` for 4 nodes of 8x H100, totaling 32 GPUs).
