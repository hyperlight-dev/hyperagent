# Resource Profiles

Profiles bundle resource limits and plugin requirements into named presets. They simplify configuration for common use cases.

There are two ways profiles are used:

- CLI `--profile` applies CPU, wall-clock, heap, and scratch limits at startup.
- `/profile apply` and the `apply_profile` tool apply resource limits and request the profile's plugin requirements.

## Using Profiles

### Via CLI

CLI profiles are useful when a run needs larger heap, scratch space, or timeouts from the start. They do not silently enable plugins, and input/output buffer profile limits are only applied through `/profile apply`, `apply_profile`, or runtime configuration.

```bash
# Single profile
hyperagent --profile file-builder

# Multiple profiles (stacked)
hyperagent --profile "web-research heavy-compute"

# With skill
hyperagent --profile file-builder --skill pptx-expert
```

### Via Slash Command

```
You: /profile apply file-builder
  ✅ Limits applied: heap: 128MB, cpu: 15000ms, wall: 60s
  📋 Profile applied: file-builder
```

### Via Tool

The LLM can apply profiles:

```
LLM calls apply_profile({ profiles: "web-research" })
```

## Built-in Profiles

| Profile         | Heap  | CPU     | Wall | Plugins         | Use Case                            |
| --------------- | ----- | ------- | ---- | --------------- | ----------------------------------- |
| `default`       | 16MB  | 1000ms  | 5s   | --              | Math, algorithms, data transforms   |
| `file-builder`  | 128MB | 15000ms | 60s  | fs-write        | ZIP, PPTX, PDF, CSV, images         |
| `web-research`  | 64MB  | 2000ms  | 120s | fetch, fs-write | API calls, web scraping, pipelines  |
| `heavy-compute` | 64MB  | 10000ms | 15s  | --              | Large datasets, crypto, simulations |

## Profile Stacking

When multiple profiles are applied with `/profile apply` or `apply_profile`, settings are combined:

- **Resource limits**: Maximum of each limit
- **Plugins**: Union of all plugins

### Example

```bash
/profile apply web-research heavy-compute
```

Results in:

- Heap: 64MB (max of 64MB and 64MB)
- CPU: 10000ms (max of 2000ms and 10000ms)
- Wall: 120s (max of 120s and 15s)
- Plugins: fetch, fs-write

## Resource Limits

### CPU Timeout

Maximum CPU time per handler execution:

- `default`: 1000ms (1 second)
- `file-builder`: 15000ms (15 seconds)
- `heavy-compute`: 10000ms (10 seconds)

Override: `--cpu-timeout <ms>` or `/timeout cpu <ms>`

### Wall Timeout

Maximum wall-clock time per execution:

- `default`: 5000ms (5 seconds)
- `file-builder`: 60000ms (60 seconds)
- `web-research`: 120000ms (120 seconds)

Override: `--wall-timeout <ms>` or `/timeout wall <ms>`

### Heap Size

Maximum JavaScript heap:

- `default`: 16MB
- `file-builder`: 128MB
- `web-research`: 64MB

Override: `--heap-size <MB>`

### Scratch Size

Scratch space (includes stack):

- `default`: 16MB
- `file-builder`: 128MB
- `web-research`: 64MB

Override: `--scratch-size <MB>`

## Plugin Requirements

Profiles can require plugins:

| Profile        | Required Plugins |
| -------------- | ---------------- |
| `file-builder` | fs-write         |
| `web-research` | fetch, fs-write  |

When a profile is applied with `/profile apply` or `apply_profile`:

1. Required plugins are enabled if not already
2. Plugin configuration may be prompted
3. Approved plugins skip audit

## When to Use Profiles

### Default (No Profile)

For pure computation:

- Mathematical calculations
- Algorithm implementation
- Data transformation (in memory)
- No file or network access

### file-builder

For generating files:

- ZIP archives
- PowerPoint presentations
- CSV/JSON exports
- Image generation

### web-research

For accessing external data:

- API calls
- Web scraping
- Data pipelines
- Combined with file output

### heavy-compute

For intensive calculations:

- Large datasets
- Cryptographic operations
- Simulations
- Complex algorithms

## Combining with Skills

Profiles provide resources, skills provide knowledge:

```bash
# Build presentations: start with file-building limits + PPTX knowledge
hyperagent --profile file-builder --skill pptx-expert

# Web scraping: start with web-research limits + scraping techniques
hyperagent --profile web-research --skill web-scraper
```

## Custom Limits

Override specific limits without a profile:

```bash
# Extra CPU time
hyperagent --cpu-timeout 5000

# More memory
hyperagent --heap-size 128

# Combined
hyperagent --cpu-timeout 5000 --heap-size 64 --wall-timeout 30000
```

Runtime adjustments:

```
/timeout cpu 5000
/timeout wall 30000
```

## Profile vs Manual Configuration

| Approach | Pros                       | Cons            |
| -------- | -------------------------- | --------------- |
| Profile  | Quick, tested combinations | Less flexible   |
| Manual   | Fine-grained control       | More typing     |
| Stacked  | Best of multiple profiles  | Can be overkill |

## Implementation Details

Profiles are defined in `src/agent/profiles.ts`:

```typescript
const profiles: Record<string, Profile> = {
  default: {
    heapSize: 16,
    cpuTimeout: 1000,
    wallTimeout: 5000,
    plugins: [],
  },
  "file-builder": {
    heapSize: 128,
    cpuTimeout: 15000,
    wallTimeout: 60000,
    plugins: ["fs-write"],
  },
  // ...
};
```

## See Also

- [SKILLS.md](SKILLS.md) - Domain expertise
- [MODULES.md](MODULES.md) - Available modules
- [USAGE.md](USAGE.md) - CLI reference
- [HOW-IT-WORKS.md](HOW-IT-WORKS.md) - System overview
