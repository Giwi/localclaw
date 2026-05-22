# Sandbox Mode

When `LOCALCLAW_SANDBOX_ENABLED=true`, `run_bash` and dynamic tool commands execute inside Docker containers with strict isolation. Without it, commands run directly on the host.

## Configuration

```
LOCALCLAW_SANDBOX_ENABLED=true    # Enable sandbox (default: false)
LOCALCLAW_SANDBOX_IMAGE=ubuntu:22.04  # Docker image (default: ubuntu:22.04)
```

## How it works

`wrapCommand()` in `src/tools/sandbox.ts` transforms a bash command into a Docker invocation:

```bash
docker run --rm --network none \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  -v "/host/path:/workspace:ro" \
  -w /workspace \
  ubuntu:22.04 \
  bash -c "<escaped command>"
```

### Security options

| Flag | Effect |
|------|--------|
| `--rm` | Container is removed after execution |
| `--network none` | No network access — prevents exfiltration |
| `--security-opt no-new-privileges` | Prevents privilege escalation via setuid |
| `--cap-drop ALL` | Drops all Linux capabilities |
| `-v "...:ro"` | Read-only mount of working directory |

### Command escaping

Before wrapping, the command is escaped:
- `\` → `\\`
- `"` → `\"`
- `$` → `\$`
- `` ` `` → `` \` ``

This prevents shell injection through the Docker CLI.

## Availability check

`isSandboxAvailable()` runs `docker info` at startup. If Docker is not reachable, the sandbox falls back to direct execution on the host:

```
WARN  Sandbox: Docker not available, falling back to direct execution
```

Docker must be installed and the server's user must have Docker permissions (member of `docker` group or root).

## Affected tools

| Tool | Sandboxed? |
|------|-----------|
| `run_bash` | Yes — command wrapped in Docker |
| `create_tool` (dynamic tools) | Yes — JS/Python/bash tools wrapped |
| `read_file` / `write_file` | No — path validation is the primary protection |
| `web_fetch` / `fetch_news` | No — network calls are expected |
| All other builtins | No — they run in the Node.js process |

## Filesystem access

The sandbox mounts the working directory as **read-only** (`:ro`). Dynamic tools that need to write files should use the `/tmp` directory inside the container or write to a Docker volume.

## Docker prerequisite

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Add user to docker group
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect

# Pull sandbox image
docker pull ubuntu:22.04
```
