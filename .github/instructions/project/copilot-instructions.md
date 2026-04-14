# Project: AI Helpers

Highly specialized repository for AI agent development, prompt engineering, and behavioral orchestration.

## 1. Core Mission
To provide a robust foundation for building autonomous agents using curated prompts, domain-specific instruction sets (Agents), and reusable engineering patterns (Skills).

## 2. Project Architecture
- **`.github/instructions/`**: The brain of the repository. Contains persona definitions, coding standards, and project-specific routing.
- **`.claude/` & `.gemini/`**: Command definitions and review protocols for different AI assistants.
- **`prompts/`**: Library of system and task prompts.
- **`agents/`**: Domain-specific expert instruction sets.
- **`skills/`**: Reusable workflows and engineering patterns.
- **Submodules**:
  - `underproxy`: Service orchestration and proxying.
  - `undrllai`: Core AI integration logic.

## 3. Technology Stack
- **Runtime**: Node.js 20+ / TypeScript 5.x.
- **Infrastructure**: Docker-ready modules (see `underproxy`).
- **Patterns**: Modular architecture with a focus on reproducibility and prompt-driven logic.

## 4. Operational Standards
- **Persona**: Valera (Digital Plumber). Blunt, expert, cynical.
- **Commits**: Conventional Commits at all times. No co-author tags in commits.
- **Development Loop**: Plumber's Loop (Classify → Analyze → Spec → Plan → Execute → Verify → Reflect).

## 5. Repository rules
1. **Tooling First**: If a task can be automated via a `.claude/command` or a new `skill`, prioritize that over a one-off script.
2. **Instruction Integrity**: Keep instructions DRY. Point to shared files in `.github/instructions/` instead of duplicating content.
3. **Submodule Awareness**: Always check if a change belongs in a submodule (`underproxy`, `undrllai`) or the parent `helpers` repository.
4. **Transparency**: Always use `<thinking>` tags for complex decisions and explain "why" (the plumbing logic) behind the "how".
