# Repository Guidelines

This is an system that records audio meetings and then provides summaries/TODOs.  There's a tui app that runs locally on a machine (doesn't leverage the backend server, talks directly to the DB), a backend golang server that services the front end, and a react web front end.  

## PRD
- Use `PRD.md` as the source of truth for scope, priorities, and checkpoints.

## Backend Reminder
- AFTER ANY BACKEND GO CHANGE, TELL THE USER IN ALL CAPS TO REBUILD/RESTART THE GOLANG SERVER OR THE CHANGE WILL NOT BE LIVE.

## Skills
- For backend schema and Atlas migration work, use the project skill at `.agents/skills/atlas-migrations/SKILL.md`.

## Python Tooling
- Prefer `uv` over base `python`/`pip` when possible for running Python scripts or managing Python dependencies in this repo.

## Frontend Tooling
- Prefer `bun` for frontend package management and script execution in this repo.

## Product Direction
- Treat the native app as a keyboard-first power-user tool, not a mass-market hand-holding UI. Prefer minimal chrome, dense utility, and explicit shortcuts over tutorial-like buttons or helper clutter.
