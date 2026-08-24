---
name: yano-deployment
description: Use this skill whenever the planner assigns deployment, release, staging, production, Docker, Compose, rollout, rollback, environment promotion, or port-allocation work. Enforce Yano's development/staging/production separation, paired port ranges, Docker-only staging and production, immutable release evidence, explicit approval, health checks, and rollback evidence.
compatibility: Requires the global `yano` CLI, Git, Docker Engine with Compose, and `curl` for health checks. Kubernetes or cloud-specific work must be delegated to the declared specialist and must not be guessed.
---

# Yano deployment contract

You are responsible for making a deployment reproducible and reversible, not
for improvising infrastructure. Read the project's deployment documentation,
`AGENTS.md`, the active Playbook and the task report before changing files.
The development source tree remains the authoritative input; staging and
production must consume an immutable built artifact.

## Environment and ports

Every project has three explicit environments:

- **development**: source code, local process, canonical path
  `~/projects/<project-name>`;
- **staging**: Docker/Compose only;
- **production**: Docker/Compose only.

Choose one backend base port `B` in `3000–3999` and preserve it for the
project. The complete matrix is:

```text
                 development  staging  production
backend                 B       B+1000    B+2000
frontend             B+3000    B+4000    B+5000
```

For example, `B=3055` means backend `3055/4055/5055` and frontend
`6055/7055/8055`. Check all six ports before reserving them; never silently
pick unrelated ports for one environment. Persist the matrix in the project's
deployment manifest and include it in the report.

If `~/projects/<project-name>` does not exist, do not copy or overwrite a
working tree silently. Report the mismatch and ask the planner whether to
create a fresh checkout, use the current repository as development, or adopt
an existing checkout. Preserve uncommitted user work.

## Required workflow

1. **Preflight**
   - confirm repository root, current branch, clean/expected working tree and
     commit SHA;
   - inspect the actual stack and existing Dockerfile/Compose/CI conventions;
   - verify `git`, `npm`/the project package manager, `docker`, `docker compose`
     and `curl` with `yano deps` or bounded `--version` probes;
   - resolve the port matrix and deployment target before writing manifests;
   - identify secrets and external services without printing their values.

2. **Development**
   - verify the application starts from source at the canonical development
     path on the development port;
   - run the project's tests and a health/readiness check;
   - keep development outside Docker unless the project explicitly requires a
     container for local development.

3. **Staging packaging**
   - use a multi-stage Docker build when the stack supports it;
   - run as a non-root user, include a meaningful healthcheck, minimize the
     runtime image and keep build tools out of it;
   - add or update `.dockerignore` and never bake secrets into an image;
   - validate Compose with `docker compose config`, build an immutable image
     tag, and record the resulting image ID/digest;
   - start staging only through Docker/Compose on the staging ports.

4. **Staging validation**
   - wait for health/readiness with a bounded timeout;
   - run the project's integration/E2E smoke checks against staging;
   - verify logs, exposed ports, dependency health and that the image running
     is the image that was built;
   - record commands, timestamps, commit SHA, image digest and test evidence.

5. **Production promotion**
   - stop at `awaiting_validation` until the user/superadmin explicitly says
     staging is accepted;
   - before production, save the previous image digest, Compose configuration,
     environment identity and a rollback command;
   - promote the exact staging image by digest, never rebuild from a moving
     branch or `latest`;
   - run the production healthcheck and a bounded smoke check, then report the
     deployment ID and rollback checkpoint to the planner.

6. **Rollback**
   - if health checks or smoke tests fail, stop the promotion, preserve logs,
     and restore the previous immutable image/configuration;
   - never delete the previous image before the new release is accepted;
   - mark the deployment blocked or rolled back and include the evidence.

## Security and authority

- Never commit `.env`, credentials, private keys or production data.
- Prefer runtime secret injection/Docker secrets; redact values from reports,
  trace and command output.
- Never run destructive database migrations or irreversible production commands
  without an explicit planner/user approval gate and a tested backup/rollback
  path.
- Do not use Kubernetes, cloud CLIs or provider-specific commands unless the
  planner assigned that capability and the matching specialist is available.
- A successful image build is not a successful deployment: require health,
  smoke, evidence and the correct port/environment identity.

## Report contract

Append a round with these sections using `report_append`:

```text
## Deployment preflight
## Port matrix
## Development verification
## Staging build and validation
## Production approval and promotion
## Rollback checkpoint
## Verification
## Verdict
```

Send the planner the project root, deployment manifest, commit SHA, image
digest, environment/ports, test commands and any blocked approval or access.
Use `yano trace context` when the deployment result disagrees with the task or
when a prior release/agent interaction may explain the failure.
