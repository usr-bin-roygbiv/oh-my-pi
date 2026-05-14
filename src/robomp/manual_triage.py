"""Manually enqueue an issue as if a webhook arrived.

Shared by the `robomp triage` CLI and the dashboard's POST /api/trigger.
"""

from __future__ import annotations

import re
from typing import Any

from robomp.db import INACTIVE_EVENT_STATES, Database, issue_key
from robomp.github_backend import GitHubBackend

_ISSUE_REF = re.compile(r"^(?P<owner>[^/\s]+)/(?P<repo>[^#\s]+)#(?P<number>\d+)$")


class InvalidIssueRef(ValueError):
    """Raised when the user-supplied issue reference can't be parsed."""


class ManualTriageError(ValueError):
    """Raised when a live GitHub issue cannot be manually triaged."""


class ManualTriageConflict(RuntimeError):
    """Raised when a stable manual delivery id is already active."""

    def __init__(self, delivery_id: str, state: str) -> None:
        self.delivery_id = delivery_id
        self.state = state
        super().__init__(f"{delivery_id} is already {state}")


def parse_issue_ref(ref: str) -> tuple[str, int]:
    """Parse `owner/repo#NN` into `("owner/repo", NN)`."""
    match = _ISSUE_REF.match(ref.strip())
    if match is None:
        raise InvalidIssueRef(f"expected owner/repo#NN, got {ref!r}")
    return f"{match.group('owner')}/{match.group('repo')}", int(match.group("number"))


def manual_delivery_id(repo_full: str, number: int) -> str:
    """Stable delivery id for manually-triggered triage. Re-runs reuse it."""
    return f"manual-{repo_full.replace('/', '__')}-{number}"


async def build_issues_opened_payload(github: GitHubBackend, repo_full: str, number: int) -> dict[str, Any]:
    """Fetch the issue + repo metadata and synthesize an `issues.opened` payload."""
    issue = await github.get_issue(repo_full, number)
    if issue.is_pull_request:
        raise ManualTriageError(f"{repo_full}#{number} is a pull request, not an issue")
    repo = await github.get_repo(repo_full)
    return {
        "action": "opened",
        "issue": {
            "number": issue.number,
            "title": issue.title,
            "body": issue.body,
            "state": issue.state,
            "user": {"login": issue.author},
            "labels": [{"name": lbl} for lbl in issue.labels],
        },
        "repository": {
            "full_name": repo.full_name,
            "default_branch": repo.default_branch,
            "clone_url": repo.clone_url,
            "private": repo.private,
        },
    }


async def enqueue_manual_triage(*, db: Database, github: GitHubBackend, repo_full: str, number: int) -> str:
    """Fetch the issue from GitHub and queue it for the worker pool.

    Returns the delivery_id. A row may already exist from a previous manual
    triage; inactive rows are replaced so the fresh payload (and reset attempt
    counter) wins. Active rows are left intact.
    """
    delivery = manual_delivery_id(repo_full, number)
    existing = db.get_event(delivery)
    if existing is not None and existing.state in ("queued", "running"):
        raise ManualTriageConflict(delivery, existing.state)

    payload = await build_issues_opened_payload(github, repo_full, number)
    replaced = db.replace_event_if_state_in(
        delivery_id=delivery,
        event_type="issues",
        repo=repo_full,
        issue_key=issue_key(repo_full, number),
        payload=payload,
        state="queued",
        allowed_existing_states=INACTIVE_EVENT_STATES,
    )
    if not replaced:
        current = db.get_event(delivery)
        state = current.state if current is not None else "active"
        raise ManualTriageConflict(delivery, state)
    return delivery


__all__ = [
    "InvalidIssueRef",
    "ManualTriageError",
    "ManualTriageConflict",
    "build_issues_opened_payload",
    "enqueue_manual_triage",
    "manual_delivery_id",
    "parse_issue_ref",
]
