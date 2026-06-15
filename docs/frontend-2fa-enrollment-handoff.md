# Frontend Handoff — Forced 2FA Enrollment on Login

> **AUDIENCE:** The implementing assistant/developer working in the **frontend** repository
> (`alsaqi`, the `@alsaqi/web` app). These are STRICT instructions. Implement them EXACTLY.
> Do not improvise, refactor, rename, reformat, or "improve" anything beyond what is written here.

---

## 0. Scope & Hard Rules (READ FIRST)

1. **Touch ONLY these two files:**
   - `apps/web/src/api/modules/auth.ts`
   - `apps/web/src/components/Login.tsx`
2. **Do NOT** modify any other file, config, dependency, lint rule, or formatting.
3. **Do NOT** rename existing variables, functions, state, or props.
4. **Do NOT** change existing endpoint paths, existing logic, or existing UI.
5. **Do NOT** add new npm packages. Use only what already exists (`react`, `fetch`, `motion/react`, `react-i18next`).
6. **Preserve** the existing code style (indentation = 2 spaces, single quotes, existing CSS variable class names).
7. The additions are **purely additive** except for two tiny insertions into existing objects (Section A) — do not delete existing lines there.
8. After implementing, run `npm run typecheck -w @alsaqi/web` and `npm run lint -w @alsaqi/web`. Both MUST pass with zero new errors/warnings. If anything fails, fix ONLY your additions; do not silence rules.
9. The HTTP calls MUST target `/api/auth/2fa/setup-pending` and `/api/auth/2fa/setup-complete` (same `/api/auth/...` prefix and `credentials: 'include'` style already used by the existing `handle2FASubmit`). Do NOT change the prefix.

---

## 1. Background (why)

The backend `POST /v1/auth/login` can return THREE success shapes:

```jsonc
{ "user": {...}, "token": "..." }                  // normal login
{ "requires2FA": true, "tempToken": "..." }         // user already has 2FA -> enter code
{ "requires2FASetup": true, "tempToken": "..." }    // user MUST enroll in 2FA first (NOT YET HANDLED)
```

The frontend currently handles the first two. It does NOT handle `requires2FASetup`, so new
Admin/Manager accounts (or any account when the global 2FA policy is on) get stuck: the app
tries to load the dashboard with no session and receives `401` on `/api/profile` and
`/api/auth/refresh`.

The backend already exposes the enrollment endpoints (do NOT implement these, they exist):

- `POST /api/auth/2fa/setup-pending` — body `{ tempToken }` → returns `{ secret, qrCodeDataUrl, backupCodes }`
- `POST /api/auth/2fa/setup-complete` — body `{ tempToken, token }` → on success sets auth cookies and returns `{ user, token }`

Your job: handle the `requires2FASetup` branch in the frontend and drive these two endpoints.

---

## A. File: `apps/web/src/api/modules/auth.ts`

### A.1 — Add `requires2FASetup` to `LoginResponseSchema`

**FIND** this exact block (inside `const LoginResponseSchema = z.object({ ... })`):

```ts
    requires2FA: z.boolean().optional(),
    tempToken: z.string().optional(),
```

**REPLACE** it with (adds ONE line in the middle, keep the other two lines unchanged):

```ts
    requires2FA: z.boolean().optional(),
    requires2FASetup: z.boolean().optional(),
    tempToken: z.string().optional(),
```

### A.2 — Add `requires2FASetup` to the `LoginResponse` interface

**FIND** this exact block (inside `export interface LoginResponse { ... }`):

```ts
  requires2FA?: boolean;
  tempToken?: string;
```

**REPLACE** it with:

```ts
  requires2FA?: boolean;
  requires2FASetup?: boolean;
  tempToken?: string;
```

> Do not change anything else in this file. No new methods are added here.

---

## B. File: `apps/web/src/components/Login.tsx`

### B.1 — Add new state hooks

**FIND** this exact existing line:

```tsx
  const [twoFAError, setTwoFAError] = useState('');
```

**INSERT IMMEDIATELY AFTER IT** these lines:

```tsx
  // Forced 2FA enrollment (requires2FASetup) state
  const [show2FASetup, setShow2FASetup] = useState(false);
  const [setupQr, setSetupQr] = useState<string | null>(null);
  const [setupBackupCodes, setSetupBackupCodes] = useState<string[]>([]);
  const [setupCode, setSetupCode] = useState('');
  const [setupError, setSetupError] = useState('');
```

### B.2 — Handle the `requires2FASetup` branch inside `handleSubmit`

In `handleSubmit`, **FIND** this exact existing block:

```tsx
      // Handle 2FA required response
      if (result && result.requires2FA) {
        setTwoFATempToken(result.tempToken ?? null);
        setShow2FA(true);
        setTwoFAError('');
        setTwoFACode('');
        setLoading(false);
        return;
      }
```

**INSERT IMMEDIATELY AFTER IT** this new block (do not modify the block above):

```tsx
      // Handle forced 2FA enrollment response: fetch the TOTP secret/QR, then show setup modal
      if (result && result.requires2FASetup) {
        const tempToken = result.tempToken ?? null;
        setTwoFATempToken(tempToken);
        setSetupError('');
        setSetupCode('');
        try {
          const res = await fetch('/api/auth/2fa/setup-pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ tempToken }),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.message || data.error || t('auth.loginFailed'));
          }
          setSetupQr(data.qrCodeDataUrl ?? null);
          setSetupBackupCodes(Array.isArray(data.backupCodes) ? data.backupCodes : []);
          setShow2FASetup(true);
        } catch (err: any) {
          setError(err.message || t('auth.loginFailed'));
        } finally {
          setLoading(false);
        }
        return;
      }
```

### B.3 — Add the `handle2FASetupComplete` handler

**FIND** the end of the existing `handle2FASubmit` function. It ends with this exact block:

```tsx
    } catch (err: any) {
      const message = err.message || t('auth.loginFailed');
      setTwoFAError(typeof message === 'object' ? message.message : message);
    } finally {
      setLoading(false);
    }
  };
```

**INSERT IMMEDIATELY AFTER IT** (after the closing `};` of `handle2FASubmit`) this new function:

```tsx
  const handle2FASetupComplete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFATempToken || setupCode.length !== 6) return;
    setSetupError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/2fa/setup-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tempToken: twoFATempToken, token: setupCode }),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error?.message || result.error || t('auth.loginFailed'));
      }
      if (result && result.user) {
        // A newly enrolled user may still be required to change their password.
        if (result.user.requires_password_change) {
          setPendingToken(result.token ?? null);
          setPendingUser(result.user);
          setShow2FASetup(false);
          setShowChangeModal(true);
          setLoading(false);
          return;
        }
        setShow2FASetup(false);
        login(result.user, result.token || 'authenticated');
      }
    } catch (err: any) {
      const message = err.message || t('auth.loginFailed');
      setSetupError(typeof message === 'object' ? message.message : message);
    } finally {
      setLoading(false);
    }
  };
```

### B.4 — Add the enrollment modal UI

**FIND** the start of the existing 2FA modal — this exact line:

```tsx
      {/* 2FA Verification Modal */}
      {show2FA && (
```

**INSERT IMMEDIATELY BEFORE** that `{/* 2FA Verification Modal */}` comment, this new modal block:

```tsx
      {/* 2FA Enrollment Modal (forced setup) */}
      {show2FASetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-[var(--color-card)] rounded-2xl p-8 w-full max-w-sm mx-4 shadow-2xl border border-[var(--color-border-soft)]"
            dir={language === Language.AR ? 'rtl' : 'ltr'}
          >
            <h3 className="text-lg font-bold text-[var(--color-text-main)] mb-2">
              {t('auth.twoFactorSetupTitle', 'Set up Two-Factor Authentication')}
            </h3>
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              {t('auth.twoFactorSetupDescription', 'Scan the QR code with your authenticator app, then enter the 6-digit code to confirm')}
            </p>

            {setupQr && (
              <img
                src={setupQr}
                alt={t('auth.twoFactorSetupTitle', 'Set up Two-Factor Authentication')}
                className="mx-auto mb-4 w-44 h-44 bg-white p-2 rounded-lg"
              />
            )}

            {setupBackupCodes.length > 0 && (
              <div className="mb-4 p-3 bg-[var(--color-bg-main)] rounded-lg text-xs font-mono grid grid-cols-2 gap-1 text-[var(--color-text-main)]">
                {setupBackupCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            )}

            {setupError && (
              <div className="p-3 mb-4 bg-[var(--color-danger-light)] border border-[var(--color-danger)]/20 rounded-xl text-[var(--color-danger)] text-sm" role="alert">
                {setupError}
              </div>
            )}

            <form onSubmit={handle2FASetupComplete}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                aria-label={t('auth.twoFactorSetupTitle', 'Set up Two-Factor Authentication')}
                className="w-full px-4 py-3.5 bg-[var(--color-card)] border border-[var(--color-border-soft)] rounded-xl focus:ring-2 focus:ring-[var(--color-primary)]/20 focus:border-[var(--color-primary)] outline-none transition-all font-mono text-center text-2xl tracking-[0.5em] text-[var(--color-text-main)]"
                placeholder="000000"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button
                type="submit"
                disabled={loading || setupCode.length !== 6}
                className="w-full py-3.5 mt-4 bg-[var(--color-primary)] text-white rounded-xl font-bold hover:bg-[var(--color-primary-hover)] transition-all disabled:opacity-50 uppercase tracking-widest text-sm"
              >
                {loading ? '...' : t('auth.verify', 'Verify')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShow2FASetup(false);
                  setSetupCode('');
                  setTwoFATempToken(null);
                  setSetupError('');
                  setSetupQr(null);
                  setSetupBackupCodes([]);
                }}
                className="w-full py-3 mt-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] font-medium transition-colors text-sm"
              >
                {t('common.cancel', 'Cancel')}
              </button>
            </form>
          </motion.div>
        </div>
      )}

```

> NOTE: `motion`, `language`, `Language`, `t`, `login`, `setPendingToken`, `setPendingUser`,
> `setShowChangeModal`, and `twoFATempToken` are ALREADY imported/declared in this file.
> Do not re-import or re-declare them.

---

## C. Mandatory Verification (must do before handing back)

Run from the frontend repo root:

```bash
npm run typecheck -w @alsaqi/web
npm run lint -w @alsaqi/web
```

Both MUST be clean. If `typecheck` complains that `result.requires2FASetup` does not exist,
it means Section A was not applied correctly — fix Section A, do not cast with `any`.

### Manual smoke test
1. Create/use an account that triggers `requires2FASetup` (Admin/Manager role, or global 2FA policy on).
2. Log in → the **enrollment modal** must appear with a QR code.
3. Scan with an authenticator app, enter the 6-digit code, submit.
4. Expected: modal closes and the user is logged in (or routed to the change-password modal if
   `requires_password_change` is true).
5. Entering a wrong code must show an inline error and NOT log the user in.

---

## D. What you MUST NOT do (explicit don'ts)

- ❌ Do not change `handle2FASubmit` or the existing `{show2FA && ...}` modal.
- ❌ Do not change the `/api/auth/2fa/validate` call.
- ❌ Do not alter `LoginForm`, `ChangePasswordModal`, `ContactAdminModal`, or any other component.
- ❌ Do not add libraries, change tsconfig/eslint/prettier, or reformat untouched code.
- ❌ Do not invent new i18n keys beyond the four used here
  (`auth.twoFactorSetupTitle`, `auth.twoFactorSetupDescription`, plus reused `auth.verify`,
  `common.cancel`, `auth.loginFailed`). Each `t(...)` call already includes an English fallback
  string, so missing translations will still render correctly; adding the keys to the i18n
  catalog is OPTIONAL and out of scope.
- ❌ Do not push directly to `main`. Use a feature branch and open a PR.

---

## E. Backend contract reference (already implemented — do NOT change backend)

```
POST /api/auth/2fa/setup-pending
  body: { "tempToken": "<2fa_setup_pending temp token from login>" }
  200 → { "secret": "...", "qrCodeDataUrl": "data:image/png;base64,...", "backupCodes": ["...", ...] }

POST /api/auth/2fa/setup-complete
  body: { "tempToken": "<same temp token>", "token": "<6-digit TOTP>" }
  200 → { "user": {...}, "token": "..." }   (auth cookies are set by the server)
  401 → { "error": "Invalid TOTP code" }
```

End of instructions.
