## Principles and Best Practices

Always follow good practices:

1. Use git frequently and meaningfully
2. Follow **Conventional Commits**
3. Keep `README.md`, documents, and this file up to date
4. Fix **all compiler warnings**
5. Keep a clean, layered project structure
6. Write high-quality comments that explain *why*, not *what*
7. Comments describe the current state, not the change history, unless it is a bugfix or a workaround for a critical known issue
8. Keep functions small, shallow, and focused on a single responsibility
9. Keep CHANGELOG concise (multiple related entries can be summarized in one line)
10. Follow [./docs/AGENTS.md](./docs/AGENTS.md) when writing documents, header comments, or anything else durable in prose

Always check whether a design/implementation is *elegant*:

(1) It retains a minimalist core and a clean conceptual model.
(2) It is simple enough that an experienced developer can understand it within five minutes without any explanation.

Always keep in mind the following principles to make it elegant before designing any new feature or changing existing behavior. Consider these principles, think twice, and then design:

1. KISS: Keep It Simple, Stupid. Is this the simplest design that works?
2. SINE: Simplicity Is Not Enough. Is this design analyzable, testable, and solver-friendly?
3. DRY: Don't Repeat Yourself. Are there existing abstractions/implementations that can be reused?
4. YAGNI: You Ain't Gonna Need It. Do we really need this feature now, or is it speculative?
5. SOLID: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. Does this design adhere to these principles?

## Before Starting Work

1. Review recent history:

   ```bash
   git log [--oneline] [--stat] [--name-only] # Show brief/extended history
   git show [--summary] [--stat] [--name-only] <commit> # Show brief/extended history of a commit
   git diff <commit> <commit> # Compare two different commits
   git checkout <commit> # Checkout and inspect all the details of a commit
   ```
2. Understand existing design decisions before changing behavior
3. For large tasks, commit incrementally with clear messages

## Before Saving Changes

ALWAYS:

1. Clear all compiler warnings
2. Format code with `clang-format`
3. Ensure all tests pass (timeouts excepted)
4. Check changes with `git status`
5. Split work into small, reviewable commits
6. Ask the user to review your changes before committing
7. Use Conventional Commit messages:

```text
<type>[optional scope]: <title>

<body>

[optional footer]
```

* Title ≤ 50 characters
* Body explains intent and design impact

**Remember:**
RefractIR prioritizes *clarity, analyzability, and solver-friendliness* over surface-level convenience.
Preserve these properties in every change.
