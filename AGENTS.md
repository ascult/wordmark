# wordmark

Chrome MV3 扩展：把网页里的英文生词就地标注为「英文原词 + 中文释义」，保持阅读流。
领域词汇见 `CONTEXT.md`；已定的架构决策见 `docs/adr/`。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `ascult/wordmark`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
