# Agent Instructions

## Project context

Read `README.md` first for the project's overall purpose, features, and technology stack.

## Documentation

This repository distinguishes between durable project knowledge and temporary working context:

* `README.md` — project overview and user-facing documentation.
* `dev-docs/` — durable development documentation, including requirements, architecture, important technical decisions, conventions, and other context that future contributors or agents should know.
* `temporary-docs/` — ephemeral working documents for the current development effort. These may contain implementation plans, scratch notes, or other temporary context and should not be treated as permanent project documentation.

When you discover information that will remain important after the current task or development session, record it in the appropriate `dev-docs/` document rather than leaving it only in session context or `temporary-docs/`.

Do not create documentation merely for the sake of documenting routine implementation details.

## Development

* Follow the project's existing technology choices and conventions unless there is a concrete reason to change them.
* Prefer simple solutions and existing abstractions over unnecessary complexity.
* Keep the implementation consistent with the requirements in `README.md`.
* Update relevant durable documentation when implementation changes invalidate or add to it.

## Working with plans

Implementation plans are normally temporary working artifacts. The current plan, when one exists, is located either in session context or under `temporary-docs/`.

Do not assume that every detail of an implementation plan should become permanent documentation. Instead, promote durable requirements, architectural decisions, constraints, and other important project knowledge into `dev-docs/`.
