"""The encrypted link to the MT5 sidecar (S-07): a self-signed certificate
trusted by its fingerprint, against a real TLS server on loopback."""

from __future__ import annotations

import hashlib
import http.server
import json
import shutil
import ssl
import subprocess
import threading

import pytest
from fastapi import HTTPException

import connections
import tls_pin
from mt5_adapter import MT5Adapter

SECRET = "s" * 32

pytestmark = pytest.mark.skipif(shutil.which("openssl") is None, reason="needs openssl")


def make_cert(directory, name: str):
    """A self-signed pair with no host name or address in it, as the install
    guide makes it. Returns (cert path, key path, fingerprint)."""
    cert, key = directory / f"{name}.crt", directory / f"{name}.key"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"]
        + ["-subj", f"/CN={name}", "-keyout", str(key), "-out", str(cert)],
        check=True,
        capture_output=True,
    )
    der = ssl.PEM_cert_to_DER_cert(cert.read_text())
    return cert, key, hashlib.sha256(der).hexdigest()


class Sidecar:
    """A stand-in sidecar: answers /health when given the secret, and records
    every request line and secret header it was sent."""

    def __init__(self, cert=None, key=None, port=0):
        seen = self.seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                given = self.headers.get("X-MT5-Bridge-Secret")
                seen.append((self.path, given))
                ok = given == SECRET
                body = json.dumps({"status": "ok"} if ok else {"error": "unauthorized"}).encode()
                self.send_response(200 if ok else 401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        http.server.ThreadingHTTPServer.allow_reuse_address = True
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
        if cert:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(cert), str(key))
            self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        self.scheme = "https" if cert else "http"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"{self.scheme}://127.0.0.1:{self.port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def certs(tmp_path):
    return make_cert(tmp_path, "sidecar"), make_cert(tmp_path, "other")


@pytest.fixture()
def sidecar(certs):
    (cert, key, _), _ = certs
    server = Sidecar(cert, key)
    yield server
    server.close()


def test_fingerprints_are_read_in_the_forms_people_paste():
    digest = "ab" * 32
    colons = ":".join("AB" for _ in range(32))
    assert tls_pin.normalise_fingerprint(colons) == digest
    assert tls_pin.normalise_fingerprint(f"sha256 Fingerprint={colons}") == digest
    assert tls_pin.normalise_fingerprint(digest.upper()) == digest
    assert tls_pin.normalise_fingerprint("  ") is None
    assert tls_pin.normalise_fingerprint(None) is None
    for bad in ("abcd", "zz" * 32, "ab" * 20):
        with pytest.raises(ValueError):
            tls_pin.normalise_fingerprint(bad)


def test_the_pinned_certificate_is_trusted_and_the_request_goes_through(sidecar, certs):
    (_, _, fingerprint), _ = certs
    adapter = MT5Adapter(sidecar.url, shared_secret=SECRET, tls_fingerprint=fingerprint)
    assert adapter._get("/health") == {"status": "ok"}
    assert adapter._get("/health") == {"status": "ok"}
    assert sidecar.seen == [("/health", SECRET), ("/health", SECRET)]


def test_another_certificate_is_refused_before_the_secret_is_sent(sidecar, certs):
    _, (_, _, other_fingerprint) = certs
    adapter = MT5Adapter(sidecar.url, shared_secret=SECRET, tls_fingerprint=other_fingerprint)
    with pytest.raises(HTTPException) as err:
        adapter._get("/health")
    assert err.value.status_code == 503
    assert "not the pinned one" in err.value.detail
    assert SECRET not in err.value.detail
    # Nothing reached the server: no request line, no secret.
    assert sidecar.seen == []


def test_a_self_signed_certificate_without_a_pin_is_refused(sidecar):
    adapter = MT5Adapter(sidecar.url, shared_secret=SECRET)
    with pytest.raises(HTTPException) as err:
        adapter._get("/health")
    assert err.value.status_code == 503
    assert sidecar.seen == []


def test_a_replaced_certificate_stops_the_link_until_the_pin_is_updated(certs):
    (cert, key, fingerprint), (other_cert, other_key, other_fingerprint) = certs
    first = Sidecar(cert, key)
    adapter = MT5Adapter(first.url, shared_secret=SECRET, tls_fingerprint=fingerprint)
    assert adapter._get("/health") == {"status": "ok"}
    port = first.port
    first.close()

    # Something else now answers on the same address with its own certificate.
    second = Sidecar(other_cert, other_key, port=port)
    try:
        for _ in range(2):
            with pytest.raises(HTTPException) as err:
                adapter._get("/health")
            assert err.value.status_code == 503
        assert second.seen == []
        # Given the new fingerprint, the link works again.
        renewed = MT5Adapter(second.url, shared_secret=SECRET, tls_fingerprint=other_fingerprint)
        assert renewed._get("/health") == {"status": "ok"}
        assert second.seen == [("/health", SECRET)]
    finally:
        second.close()


def test_an_unreachable_server_is_a_pin_error():
    with pytest.raises(tls_pin.PinError, match="could not read the certificate"):
        tls_pin.pinned_context("https://127.0.0.1:1", "ab" * 32, timeout=2)
    with pytest.raises(tls_pin.PinError, match="needs an https"):
        tls_pin.pinned_context("http://127.0.0.1:9100", "ab" * 32)


def test_plain_http_still_works_for_a_sidecar_on_the_same_machine():
    server = Sidecar()
    try:
        adapter = MT5Adapter(server.url, shared_secret=SECRET)
        assert adapter._get("/health") == {"status": "ok"}
    finally:
        server.close()


# --- the connection's settings ------------------------------------------- #
MT5 = {"id": "demo", "platform": "mt5", "url": "https://10.0.0.20:9100", "secret": SECRET}


def test_a_connection_carries_its_fingerprint():
    (conn,) = connections.parse_managed([{**MT5, "tls_fingerprint": ":".join(["AB"] * 32)}])
    assert conn.tls_fingerprint == "ab" * 32
    (plain,) = connections.parse_managed([MT5])
    assert plain.tls_fingerprint is None


def test_a_bad_fingerprint_or_one_on_plain_http_is_refused():
    with pytest.raises(connections.ManifestError, match="tls_fingerprint"):
        connections.parse_managed([{**MT5, "tls_fingerprint": "nonsense"}])
    with pytest.raises(connections.ManifestError, match="https://"):
        connections.parse_managed(
            [{**MT5, "url": "http://10.0.0.20:9100", "tls_fingerprint": "ab" * 32}]
        )


def test_loopback_addresses_are_recognised():
    assert connections.is_loopback_url("http://127.0.0.1:9100")
    assert connections.is_loopback_url("http://localhost:9100")
    assert not connections.is_loopback_url("http://10.0.0.20:9100")
    assert not connections.is_loopback_url(None)


def test_status_says_where_each_lan_link_goes_and_how_it_is_protected():
    import adapters

    def link(**fields):
        (conn,) = connections.parse_managed([{**MT5, **fields}])
        return adapters.connection_link(conn)

    assert link(tls_fingerprint="ab" * 32) == {
        "host": "10.0.0.20",
        "port": 9100,
        "security": "tls_pinned",
    }
    assert link()["security"] == "tls"
    assert link(url="http://10.0.0.20:9100")["security"] == "plain"
    assert link(url="http://127.0.0.1:9100")["security"] == "loopback"

    (ib,) = connections.parse_managed(
        [{"id": "paper", "platform": "ib", "host": "10.0.0.30", "port": 4002}]
    )
    assert adapters.connection_link(ib) == {"host": "10.0.0.30", "port": 4002, "security": "plain"}
    (oanda,) = connections.parse_managed(
        [{"id": "o", "platform": "oanda", "token": "t", "account_id": "1"}]
    )
    assert adapters.connection_link(oanda) is None
