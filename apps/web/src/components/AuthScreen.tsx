import { useState, type FormEvent } from 'react';
import { describeError } from '../api.js';
import type { Session } from '../hooks/useSession.js';
import { Avatar } from './Avatar.js';
import { Icon } from './Icon.js';

const HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function Brand(): React.ReactElement {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">R</span>
      <span className="brand-name">Riff</span>
    </span>
  );
}

/** Sign-in and registration; accounts saved in this browser sign in with one click. */
export function AuthScreen({ session }: { session: Session }): React.ReactElement {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (work: () => Promise<void>, fallback: string): Promise<void> => {
    setBusy(true);
    setError('');
    try { await work(); } catch (failure) { setError(describeError(failure, fallback)); } finally { setBusy(false); }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (mode === 'login') { void run(() => session.signIn(identifier.trim(), password), '登录失败，请检查账号和密码。'); return; }
    if (password.length < 8) { setError('密码至少需要 8 位。'); return; }
    if (!HANDLE_PATTERN.test(handle)) { setError('账号标识以字母或数字开头，只能包含字母、数字、点、下划线和连字符。'); return; }
    void run(() => session.register({
      displayName: displayName.trim(),
      handle: handle.trim().toLowerCase(),
      ...(email.trim() ? { email: email.trim() } : {}),
      password,
    }), '注册失败，请检查填写的资料。');
  };

  const canSubmit = mode === 'login' ? identifier.trim() && password : displayName.trim() && handle.trim() && password;
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        <h1 id="auth-title">{mode === 'login' ? '欢迎回来' : '创建你的账户'}</h1>
        <p className="auth-lead">{mode === 'login' ? '登录后继续你的项目、讨论和 Agent 协作。' : '注册后可以创建项目，或接受别人发来的项目邀请。'}</p>

        {mode === 'login' && session.savedAccounts.length > 0 ? (
          <div className="saved-accounts" aria-label="本机保存的账号">
            {session.savedAccounts.map((account) => (
              <div className="saved-account" key={account.identifier}>
                <button type="button" className="saved-account-main" disabled={busy} onClick={() => void run(() => session.switchTo(account), `“${account.displayName}”的保存密码已失效，请手动登录。`)}>
                  <Avatar id={account.principalId ?? account.identifier} name={account.displayName} kind="human" size="sm" />
                  <span className="saved-account-copy"><strong>{account.displayName}</strong><small>{account.handle ? `@${account.handle}` : account.identifier}</small></span>
                  <Icon name="chevronRight" size={14} />
                </button>
                <button type="button" className="icon-button" aria-label={`从本机移除 ${account.displayName}`} title="从本机移除" onClick={() => session.forgetAccount(account.identifier)}><Icon name="close" size={14} /></button>
              </div>
            ))}
            <p className="field-hint">账号与密码只保存在这个浏览器中；在共享电脑上用完请移除。</p>
          </div>
        ) : null}

        <form className="form" onSubmit={submit}>
          {mode === 'login' ? (
            <label className="field">
              <span>账号标识或邮箱</span>
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" placeholder="例如 zhangsan" autoFocus />
            </label>
          ) : (
            <>
              <label className="field"><span>显示名称</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="例如 张三" autoFocus /></label>
              <label className="field"><span>账号标识</span><input value={handle} onChange={(event) => setHandle(event.target.value.replace(/\s+/gu, '').toLowerCase())} autoComplete="username" placeholder="用于登录和被邀请，例如 zhangsan" /></label>
              <label className="field"><span>邮箱 <em>可选</em></span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" /></label>
            </>
          )}
          <label className="field">
            <span>密码</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'login' ? '' : '至少 8 位'} />
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button type="submit" className="button primary block" disabled={busy || !canSubmit}>{busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账户'}</button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? '还没有账户？' : '已经有账户了？'}
          <button type="button" className="link-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? '注册' : '去登录'}</button>
        </p>
      </section>
    </main>
  );
}
