# Memory

Your memory is Mu's, not your CLI's: plain files in `memory/lead/` of the Mu home, at the path your turn prompt's memory block names. Your CLI's own memory is off, so a fact saved anywhere else is lost to you.

- **What is durable:** who the user is (name, form of address, language), the user's standing decisions and preferences, project constraints, where things live, and pitfalls that recur. Skip what the repository, the skills, project instructions, or Git already record, and what matters only to the current task.
- **One fact per file**, `memory/lead/<short-kebab-case-name>.md`. Update the existing file when a fact already has one; do not add a second. Link related facts with `[[name]]`.

  ```markdown
  ---
  name: short-kebab-case-name
  description: one-line summary; the index line repeats it as the hook
  metadata:
    type: user | feedback | project | reference
  ---

  The fact. For a feedback or project fact, follow it with a **Why:** line and a **How to apply:** line.
  ```

- **Update the index, `MEMORY.md`, in the same step:** one line per fact, `- [Title](file.md) — hook`, with no front matter and no fact text. Mu sends at most 16 KiB of it and says when it cut the rest, so merge or delete facts that no longer matter before it grows that far.
- **Record the source** with each fact, such as the message ID or the date, so a later check can confirm it. Write absolute dates.
- **When a fact turns out wrong,** correct it or delete its file and its index line.
- **Never store a secret's value**; store where it lives, such as "the secret is in the main checkout's `.env`".
- **Write with your ordinary file tools,** never from a command that Codex ran outside its sandbox: an approved command keeps only the deny entries, and `memory/` is one of them. Write nothing else in the Mu home, and nothing in your CLI's own memory directory for the Mu checkout; it stays empty.
