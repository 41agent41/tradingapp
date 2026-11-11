"""The Lightstreamer text-protocol client (lightstreamer.py). The server is an
httpx MockTransport answering with recorded protocol lines."""

from __future__ import annotations

from urllib.parse import parse_qs

import httpx
import pytest

import lightstreamer
from lightstreamer import LightstreamerClient, LightstreamerError, Subscription, decode_update


def _server(monkeypatch, streams, control="REQOK,1\r\n"):
    """Serve each stream connection the next body in ``streams``; record every
    request as (path, query, body)."""
    seen = []
    bodies = list(streams)

    def handler(request):
        path = request.url.path
        seen.append(
            (
                f"{request.url.scheme}://{request.url.host}{path}",
                dict(request.url.params),
                {k: v[0] for k, v in parse_qs(request.content.decode()).items()},
            )
        )
        if path.endswith("/control.txt"):
            return httpx.Response(200, text=control)
        return httpx.Response(200, content=bodies.pop(0).encode())

    real_client = httpx.Client
    monkeypatch.setattr(
        lightstreamer.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    return seen


def _lines(*lines):
    return "".join(f"{line}\r\n" for line in lines)


# --------------------------------------------------------------------------- #
# Update decoding
# --------------------------------------------------------------------------- #
def test_decode_update_first_update_sets_every_field():
    values, changed = decode_update("1.1000|1.1002|#|$", [None] * 4)
    assert values == ["1.1000", "1.1002", None, ""]
    assert changed == {0, 1, 2, 3}


def test_decode_update_empty_is_unchanged_and_caret_skips_fields():
    previous = ["20:04:40", "a", "b", "c", "d", "3.00", "3.01", "x", "y", "z"]
    values, changed = decode_update("20:06:10|^4|3.02|3.03|||", previous)
    assert values == ["20:06:10", "a", "b", "c", "d", "3.02", "3.03", "x", "y", "z"]
    assert changed == {0, 5, 6}


def test_decode_update_percent_decodes_values_and_ignores_extra_fields():
    values, changed = decode_update("a%7Cb|%23literal|more|extra", [None, None, None])
    assert values == ["a|b", "#literal", "more"]
    assert changed == {0, 1, 2}


# --------------------------------------------------------------------------- #
# A session
# --------------------------------------------------------------------------- #
def test_opens_a_session_subscribes_and_delivers_full_values(monkeypatch):
    seen = _server(
        monkeypatch,
        [
            _lines(
                "CONOK,S1abc,50000,5000,*",
                "SERVNAME,Lightstreamer HTTP Server",
                "SUBOK,1,2,2",
                "U,1,1,1.1000|1.1002",
                "PROBE",
                "U,1,2,150.10|150.13",
                "U,1,1,|1.1003",
                "U,9,1,ignored",
            )
        ],
    )
    got = []
    client = LightstreamerClient("https://push.example.com/", "ACC1", "CST-a|XST-b")
    client.run(
        [Subscription("MERGE", ["MARKET:A", "MARKET:B"], ["BID", "OFFER"], snapshot=True)],
        got.append,
        lambda: False,
    )

    assert [(u.item, u.values, u.changed) for u in got] == [
        ("MARKET:A", {"BID": "1.1000", "OFFER": "1.1002"}, {"BID", "OFFER"}),
        ("MARKET:B", {"BID": "150.10", "OFFER": "150.13"}, {"BID", "OFFER"}),
        ("MARKET:A", {"BID": "1.1000", "OFFER": "1.1003"}, {"OFFER"}),
    ]
    create, control = seen
    assert create[0] == "https://push.example.com/lightstreamer/create_session.txt"
    assert create[1] == {"LS_protocol": "TLCP-2.1.0"}
    assert create[2]["LS_user"] == "ACC1"
    assert create[2]["LS_password"] == "CST-a|XST-b"
    assert create[2]["LS_cid"] == "mgQkwtwdysogQz2BJ4Ji kOj2Bg"
    assert control[0] == "https://push.example.com/lightstreamer/control.txt"
    assert control[1] == {"LS_protocol": "TLCP-2.1.0", "LS_session": "S1abc"}
    assert control[2] == {
        "LS_reqId": "1",
        "LS_op": "add",
        "LS_subId": "1",
        "LS_mode": "MERGE",
        "LS_group": "MARKET:A MARKET:B",
        "LS_schema": "BID OFFER",
        "LS_snapshot": "true",
    }


def test_the_client_id_is_sent_exactly_as_the_specification_writes_it(monkeypatch):
    raw = []
    real_client = httpx.Client

    def handler(request):
        raw.append(request.content.decode())
        return httpx.Response(200, content=b"")

    monkeypatch.setattr(
        lightstreamer.httpx,
        "Client",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    LightstreamerClient("https://push.example.com", "u", "p").run([], lambda u: None, lambda: False)
    assert "LS_cid=mgQkwtwdysogQz2BJ4Ji%20kOj2Bg" in raw[0]


def test_rebinds_on_loop_to_the_control_link_and_keeps_item_values(monkeypatch):
    seen = _server(
        monkeypatch,
        [
            _lines("CONOK,S1abc,50000,5000,push2.example.com", "U,1,1,1.1000|1.1002", "LOOP,0"),
            _lines("CONOK,S1abc,50000,5000,push2.example.com", "U,1,1,1.1001|"),
        ],
    )
    got = []
    LightstreamerClient("https://push.example.com", "ACC1", "pw").run(
        [Subscription("MERGE", ["MARKET:A"], ["BID", "OFFER"])], got.append, lambda: False
    )

    assert [u.values for u in got] == [
        {"BID": "1.1000", "OFFER": "1.1002"},
        {"BID": "1.1001", "OFFER": "1.1002"},
    ]
    paths = [s[0] for s in seen]
    assert paths == [
        "https://push.example.com/lightstreamer/create_session.txt",
        "https://push2.example.com/lightstreamer/control.txt",
        "https://push2.example.com/lightstreamer/bind_session.txt",
    ]
    assert seen[2][2]["LS_session"] == "S1abc"  # and it did not subscribe twice


def test_a_refused_session_raises_with_the_servers_code(monkeypatch):
    _server(monkeypatch, [_lines("CONERR,1,User/password check failed")])
    with pytest.raises(LightstreamerError) as err:
        LightstreamerClient("https://push.example.com", "u", "p").run(
            [], lambda u: None, lambda: False
        )
    assert err.value.code == 1
    assert "password" in err.value.message


def test_a_session_the_server_closes_raises(monkeypatch):
    _server(monkeypatch, [_lines("CONOK,S1,50000,5000,*", "END,8,Session count limit reached")])
    with pytest.raises(LightstreamerError) as err:
        LightstreamerClient("https://push.example.com", "u", "p").run(
            [], lambda u: None, lambda: False
        )
    assert err.value.code == 8


def test_a_refused_subscription_raises(monkeypatch):
    _server(
        monkeypatch,
        [_lines("CONOK,S1,50000,5000,*")],
        control="REQERR,1,21,Bad Group name\r\n",
    )
    with pytest.raises(LightstreamerError) as err:
        LightstreamerClient("https://push.example.com", "u", "p").run(
            [Subscription("MERGE", ["NOPE"], ["BID"])], lambda u: None, lambda: False
        )
    assert (err.value.code, err.value.message) == (21, "Bad Group name")


def test_stops_when_asked(monkeypatch):
    _server(monkeypatch, [_lines("CONOK,S1,50000,5000,*", "U,1,1,1|2", "U,1,1,3|4")])
    got = []
    LightstreamerClient("https://push.example.com", "u", "p").run(
        [Subscription("MERGE", ["MARKET:A"], ["BID", "OFFER"])],
        got.append,
        lambda: len(got) >= 1,
    )
    assert len(got) == 1


def test_an_http_error_raises(monkeypatch):
    real_client = httpx.Client
    monkeypatch.setattr(
        lightstreamer.httpx,
        "Client",
        lambda **kw: real_client(
            transport=httpx.MockTransport(lambda r: httpx.Response(503, text="down")), **kw
        ),
    )
    with pytest.raises(LightstreamerError) as err:
        LightstreamerClient("https://push.example.com", "u", "p").run(
            [], lambda u: None, lambda: False
        )
    assert err.value.code == 503
