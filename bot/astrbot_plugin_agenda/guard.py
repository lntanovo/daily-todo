"""Group policy state shared by the agenda plugin.

The policy is plain in-memory data so it can be swapped at runtime when the
owner edits the group list from the plugin view — no restart, and no coupling
to AstrBot's own whitelist (which is cached at pipeline start-up).
"""

from __future__ import annotations

_chat: set[str] = set()
_watch: set[str] = set()


def _clean(values) -> set[str]:
    """Normalise a list of group ids into a set of non-empty strings."""
    out: set[str] = set()
    for value in values or []:
        text = str(value).strip()
        if text:
            out.add(text)
    return out


def set_policy(chat, watch) -> None:
    """Replace both group sets.

    Args:
        chat: Group ids where the bot may talk.
        watch: Group ids that are only recorded, never answered.
    """
    global _chat, _watch
    _chat = _clean(chat)
    _watch = _clean(watch) - _chat


def chat_group_ids() -> set[str]:
    """Return a copy of the chat group ids."""
    return set(_chat)


def watch_group_ids() -> set[str]:
    """Return a copy of the watched group ids."""
    return set(_watch)


def is_chat(group_id: str) -> bool:
    """Whether the bot is allowed to answer in this group."""
    return str(group_id).strip() in _chat


def is_watch(group_id: str) -> bool:
    """Whether this group is silently recorded."""
    return str(group_id).strip() in _watch


def mask_secret(text: str) -> str:
    """Mask anything that looks like an API key inside a log line.

    Args:
        text: Arbitrary text.

    Returns:
        Text with ``sk-`` style keys replaced by a placeholder.
    """
    if not text:
        return text
    out = []
    for token in str(text).split():
        if token.startswith("sk-") and len(token) > 12:
            out.append("sk-***")
        else:
            out.append(token)
    return " ".join(out)
