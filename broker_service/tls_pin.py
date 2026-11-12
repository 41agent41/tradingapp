"""Certificate pinning for a link to one known server (S-07).

The MT5 sidecar runs on the LAN with a self-signed certificate, which no
certificate authority vouches for. Instead the connection is given the
certificate's SHA-256 fingerprint, and :func:`pinned_context` trusts exactly
that certificate:

1. It reads the certificate the server presents, without sending anything.
2. If its fingerprint is not the pinned one, it refuses.
3. It returns a context that trusts only that certificate, so every later
   request is made over TLS to the holder of its private key.

The host name is not checked: the certificate is identified by its
fingerprint, so it needs no name or address in it and keeps working when the
server's address changes.
"""

from __future__ import annotations

import hashlib
import socket
import ssl
from typing import Optional
from urllib.parse import urlsplit

_HEX = set("0123456789abcdef")


class PinError(Exception):
    """The server's certificate could not be read, or is not the pinned one."""


def normalise_fingerprint(value: Optional[str]) -> Optional[str]:
    """``AB:CD:...``, ``ab cd ...`` or plain hex as 64 lower-case hex digits.
    None for an empty value; ValueError for anything else."""
    text = "".join(c for c in (value or "").lower() if c not in ": -\t")
    if text.startswith("sha256fingerprint="):
        text = text[len("sha256fingerprint=") :]
    if not text:
        return None
    if len(text) != 64 or not set(text) <= _HEX:
        raise ValueError("a SHA-256 certificate fingerprint is 64 hex digits")
    return text


def fingerprint_of(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


def _presented_certificate(host: str, port: int, timeout: float) -> bytes:
    """The certificate the server presents, DER encoded. Nothing is trusted
    here and nothing but the TLS handshake is sent."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with context.wrap_socket(raw, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
    except (OSError, ssl.SSLError) as exc:
        raise PinError(f"could not read the certificate of {host}:{port}: {exc}") from exc
    if not der:
        raise PinError(f"{host}:{port} presented no certificate")
    return der


def pinned_context(url: str, fingerprint: str, timeout: float = 10.0) -> ssl.SSLContext:
    """A context that trusts only the certificate with ``fingerprint`` (64 hex
    digits), after checking that ``url``'s server presents it."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise PinError("a certificate fingerprint needs an https:// address")
    der = _presented_certificate(parts.hostname, parts.port or 443, timeout)
    seen = fingerprint_of(der)
    if seen != fingerprint:
        raise PinError(
            "the server's certificate is not the pinned one "
            f"(its SHA-256 fingerprint starts {seen[:16].upper()}, "
            f"the connection expects {fingerprint[:16].upper()})"
        )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = False
    context.verify_mode = ssl.CERT_REQUIRED
    # Trust this certificate itself, whether or not it is marked as a CA.
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    context.load_verify_locations(cadata=der)
    return context
