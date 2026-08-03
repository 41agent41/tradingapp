/**
 * Tests for the order-endpoint RBAC + MFA middleware. Both layers are opt-in;
 * with neither env var set the middleware is a pass-through (backward compat).
 */
import type { NextFunction, Request, Response } from 'express';

import { orderAuth, isMfaRequired, isTradingAuthRequired } from '../src/middleware/orderAuth.js';

// base32("12345678901234567890") — the RFC 6238 SHA-1 vector secret.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, path: '/', method: 'POST' } as unknown as Request;
}

function mockRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = jest.fn((code: number) => {
    (res as any).statusCode = code;
    return res;
  }) as any;
  res.json = jest.fn((body: unknown) => {
    (res as any).body = body;
    return res;
  }) as any;
  return res;
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.TRADING_TOKENS;
  delete process.env.ORDER_MFA_SECRET;
});

describe('orderAuth — pass-through when unconfigured', () => {
  it('calls next() when neither RBAC nor MFA is configured', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq(), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(isTradingAuthRequired()).toBe(false);
    expect(isMfaRequired()).toBe(false);
  });
});

describe('orderAuth — RBAC (trader role)', () => {
  beforeEach(() => {
    process.env.TRADING_TOKENS = 'trader-tok-1, trader-tok-2';
  });

  it('403s when the trading token is missing', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(isTradingAuthRequired()).toBe(true);
  });

  it('403s when the trading token is wrong', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-trading-token': 'nope' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes with a valid trading token (and no MFA configured)', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-trading-token': 'trader-tok-2' }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('orderAuth — MFA (TOTP)', () => {
  beforeEach(() => {
    process.env.ORDER_MFA_SECRET = SECRET;
    jest.spyOn(Date, 'now').mockReturnValue(59 * 1000); // RFC vector → code 287082
  });

  it('401s when the MFA code is missing', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(isMfaRequired()).toBe(true);
  });

  it('401s when the MFA code is invalid', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-mfa-code': '000000' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes with a valid TOTP code', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-mfa-code': '287082' }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('orderAuth — RBAC + MFA together', () => {
  beforeEach(() => {
    process.env.TRADING_TOKENS = 'trader-tok-1';
    process.env.ORDER_MFA_SECRET = SECRET;
    jest.spyOn(Date, 'now').mockReturnValue(59 * 1000);
  });

  it('requires both: valid token but missing code → 401', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-trading-token': 'trader-tok-1' }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes with both a valid token and a valid code', () => {
    const next = jest.fn() as NextFunction;
    const res = mockRes();
    orderAuth(mockReq({ 'x-trading-token': 'trader-tok-1', 'x-mfa-code': '287082' }), res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
