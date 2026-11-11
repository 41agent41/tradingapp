"""A small Lightstreamer client: enough of TLCP 2.1.0 to read subscriptions.

IG publishes live prices and trade events over Lightstreamer. This speaks its
text protocol (TLCP) over plain HTTP streaming with ``httpx``, which the
service already uses, rather than adding the vendor's client library.

What it does:

- opens a session (``create_session.txt``) and reads the stream line by line;
- subscribes once the session is confirmed (``control.txt``, ``LS_op=add``);
- decodes updates (``U``), which send only the fields that changed, into the
  full current values of an item;
- rebinds (``bind_session.txt``) when the server ends a stream connection
  with ``LOOP``, keeping the session and its subscriptions.

Anything else that ends the stream (``END``, ``CONERR``, a dropped
connection) is raised or returned to the caller, which opens a new session.
It never unsubscribes: a caller that wants other items stops and starts again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import quote, unquote, urlencode, urlsplit

import httpx

PROTOCOL = "TLCP-2.1.0"
# The client id the specification gives to every client that is not one of
# Lightstreamer's own libraries.
_CLIENT_ID = "mgQkwtwdysogQz2BJ4Ji kOj2Bg"
# The server sends a line at least this often, so a stop is seen this soon.
_KEEPALIVE_MILLIS = 5000


class LightstreamerError(Exception):
    """The server refused the session or a request, or closed the session."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"Lightstreamer error {code}: {message}")
        self.code = code
        self.message = message


@dataclass
class Subscription:
    """Items read with one schema. ``mode`` is MERGE (current state, such as a
    price) or DISTINCT (events, such as trade confirmations)."""

    mode: str
    items: Sequence[str]
    fields: Sequence[str]
    snapshot: bool = False


@dataclass
class Update:
    """One update of one item."""

    subscription: int  # index into the subscriptions given to ``run``
    item: str
    # Every field's current value (None when the server sent null).
    values: Dict[str, Optional[str]]
    # The fields this update carried; the rest are as they were.
    changed: Set[str] = field(default_factory=set)


def decode_update(
    payload: str, previous: List[Optional[str]]
) -> Tuple[List[Optional[str]], Set[int]]:
    """Apply a ``U`` message's field values to an item's previous values.

    Values are separated by ``|``. An empty value is unchanged, ``#`` is null,
    ``$`` is the empty string, ``^N`` leaves the next N fields unchanged, and
    anything else is the percent-encoded new value. Returns the new values and
    the positions that were sent.
    """
    values = list(previous)
    changed: Set[int] = set()
    index = 0
    for token in payload.split("|"):
        if index >= len(values):
            break
        if token == "":
            index += 1
        elif token == "#":
            values[index] = None
            changed.add(index)
            index += 1
        elif token == "$":
            values[index] = ""
            changed.add(index)
            index += 1
        elif token[0] == "^" and token[1:].isdigit():
            index += int(token[1:])
        else:
            values[index] = unquote(token)
            changed.add(index)
            index += 1
    return values, changed


class LightstreamerClient:
    """One streaming session. Not reusable: make a new one to reconnect."""

    def __init__(
        self,
        endpoint: str,
        user: str,
        password: str,
        *,
        adapter_set: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._user = user
        self._password = password
        self._adapter_set = adapter_set
        self._timeout = httpx.Timeout(timeout, read=30.0)
        self._session: Optional[str] = None
        # Where rebinds and control requests go; the server may name another host.
        self._control = self._endpoint
        self._subscriptions: List[Subscription] = []
        self._state: Dict[Tuple[int, int], List[Optional[str]]] = {}

    def run(
        self,
        subscriptions: Sequence[Subscription],
        on_update: Callable[[Update], None],
        should_stop: Callable[[], bool],
    ) -> None:
        """Stream ``subscriptions`` until ``should_stop()`` is true (checked on
        every line the server sends) or the server ends the stream. Raises
        :class:`LightstreamerError` when the server refuses or closes the
        session, and ``httpx.HTTPError`` on a connection failure."""
        self._subscriptions = list(subscriptions)
        params: Dict[str, Any] = {
            "LS_user": self._user,
            "LS_password": self._password,
            "LS_cid": _CLIENT_ID,
            "LS_keepalive_millis": _KEEPALIVE_MILLIS,
            "LS_send_sync": "false",
        }
        if self._adapter_set:
            params["LS_adapter_set"] = self._adapter_set
        url = f"{self._endpoint}/lightstreamer/create_session.txt"
        with httpx.Client(timeout=self._timeout) as client:
            while True:
                again = self._stream(client, url, params, on_update, should_stop)
                if not again or should_stop():
                    return
                # The server ended this connection, not the session: rebind.
                url = f"{self._control}/lightstreamer/bind_session.txt"
                params = {
                    "LS_session": self._session,
                    "LS_keepalive_millis": _KEEPALIVE_MILLIS,
                    "LS_send_sync": "false",
                }

    # -- one stream connection --------------------------------------------- #
    def _stream(
        self,
        client: httpx.Client,
        url: str,
        params: Dict[str, Any],
        on_update: Callable[[Update], None],
        should_stop: Callable[[], bool],
    ) -> bool:
        """Read one stream connection. True when the server asked for a rebind."""
        with client.stream(
            "POST",
            url,
            params={"LS_protocol": PROTOCOL},
            content=_form(params),
            headers={"Content-Type": "text/plain"},
        ) as resp:
            if resp.status_code >= 400:
                resp.read()
                raise LightstreamerError(resp.status_code, resp.text[:200])
            for line in resp.iter_lines():
                if should_stop():
                    return False
                if not line:
                    continue
                tag, _, rest = line.partition(",")
                if tag == "U":
                    self._on_update(rest, on_update)
                elif tag == "CONOK":
                    first = self._session is None
                    parts = rest.split(",")
                    self._session = parts[0]
                    link = unquote(parts[3]) if len(parts) > 3 else "*"
                    if link and link != "*":
                        scheme = urlsplit(self._endpoint).scheme or "https"
                        self._control = f"{scheme}://{link}"
                    if first:
                        self._subscribe(client)
                elif tag == "LOOP":
                    return True
                elif tag in ("CONERR", "END", "ERROR"):
                    code, _, message = rest.partition(",")
                    raise LightstreamerError(_int(code), unquote(message))
        return False

    def _subscribe(self, client: httpx.Client) -> None:
        for number, sub in enumerate(self._subscriptions, start=1):
            body = _form(
                {
                    "LS_reqId": number,
                    "LS_op": "add",
                    "LS_subId": number,
                    "LS_mode": sub.mode,
                    "LS_group": " ".join(sub.items),
                    "LS_schema": " ".join(sub.fields),
                    "LS_snapshot": "true" if sub.snapshot else "false",
                }
            )
            resp = client.post(
                f"{self._control}/lightstreamer/control.txt",
                params={"LS_protocol": PROTOCOL, "LS_session": self._session},
                content=body,
                headers={"Content-Type": "text/plain"},
            )
            if resp.status_code >= 400:
                raise LightstreamerError(resp.status_code, resp.text[:200])
            for line in resp.text.splitlines():
                tag, _, rest = line.partition(",")
                if tag == "REQERR":
                    _, _, tail = rest.partition(",")
                    code, _, message = tail.partition(",")
                    raise LightstreamerError(_int(code), unquote(message))
                if tag == "ERROR":
                    code, _, message = rest.partition(",")
                    raise LightstreamerError(_int(code), unquote(message))

    def _on_update(self, rest: str, on_update: Callable[[Update], None]) -> None:
        parts = rest.split(",", 2)
        if len(parts) < 3 or not (parts[0].isdigit() and parts[1].isdigit()):
            return
        sub_id, item_index = int(parts[0]), int(parts[1])
        if not 1 <= sub_id <= len(self._subscriptions):
            return
        sub = self._subscriptions[sub_id - 1]
        if not 1 <= item_index <= len(sub.items):
            return
        key = (sub_id, item_index)
        previous = self._state.get(key) or [None] * len(sub.fields)
        values, changed = decode_update(parts[2], previous)
        self._state[key] = values
        on_update(
            Update(
                subscription=sub_id - 1,
                item=sub.items[item_index - 1],
                values=dict(zip(sub.fields, values, strict=False)),
                changed={sub.fields[i] for i in changed},
            )
        )


def _form(params: Dict[str, Any]) -> bytes:
    return urlencode({k: str(v) for k, v in params.items()}, quote_via=quote).encode()


def _int(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0
