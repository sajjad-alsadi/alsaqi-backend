/**
 * مجموعة مفاتيح التحقق من JWT ودعم التدوير المجدول/بعد حادث.
 * (JWT verification-key-set abstraction for scheduled / post-incident rotation.)
 *
 * المتطلب: 19.2، 19.5 — تدوير مفاتيح توقيع JWT.
 * Reference: docs/key-rotation-procedure.md §1 (JWT RS256 rotation),
 *            design.md (تدوير المفاتيح والأسرار)، tasks.md 24.2.
 *
 * ── الفكرة ──────────────────────────────────────────────────────────────────
 * يوقَّع كل رمز جديد بالمفتاح الخاص **الحالي** فقط، بينما يُتحقَّق منه مقابل
 * مجموعة مفاتيح عامة (verification key set). يحدّد وضع التدوير ما إذا كان المفتاح
 * **السابق** ضمن هذه المجموعة:
 *
 *   • التدوير المجدول (scheduled): يبقى المفتاح العام السابق ضمن مجموعة التحقق
 *     خلال **نافذة انتقالية** محدودة (لا تتجاوز أقصى عمر refresh token)، فتُقبل
 *     رموز المفتاح السابق حتى انقضاء النافذة، ثم تُرفض (AC 19.2).
 *   • التدوير بعد حادث (post-incident): لا يُضاف المفتاح السابق إطلاقاً إلى
 *     مجموعة التحقق، فتُرفض رموزه فوراً دون أي مدة قبول — إلى جانب الإبطال
 *     الجماعي عبر `session_version` (AC 19.5).
 *
 * هذا المنطق نقي وحتمي (يأخذ `now` كمعامل) ليكون قابلاً للاختبار، بينما يبقى
 * `verifyJwtWithKeySet` غلافاً رفيعاً حول `jsonwebtoken`.
 */

import jwt from 'jsonwebtoken';

/** وضع التدوير الذي يحدّد قبول/رفض المفتاح السابق. */
export type JwtRotationMode = 'scheduled' | 'post-incident';

/**
 * إعداد مجموعة مفاتيح التحقق المُستخدَم لحلّ المفاتيح الفعّالة في لحظة معيّنة.
 *
 * - `currentPublicKey`: المفتاح العام الحالي (دائماً ضمن مجموعة التحقق).
 * - `previousPublicKey`: المفتاح العام السابق المباشر (إن وُجد). يُقبل فقط ضمن
 *   النافذة الانتقالية وفي وضع `scheduled`.
 * - `mode`: وضع التدوير (`scheduled` يقبل السابق ضمن النافذة، `post-incident`
 *   يرفضه فوراً).
 * - `rotatedAt`: وقت تنفيذ التدوير (epoch ms). تُحسب نهاية النافذة منه.
 * - `transitionWindowMs`: طول النافذة الانتقالية (ms) للوضع المجدول. القيمة
 *   غير الموجبة (≤ 0) تعني عدم قبول السابق إطلاقاً.
 */
export interface JwtVerificationKeyConfig {
  currentPublicKey: string;
  previousPublicKey?: string | null;
  mode: JwtRotationMode;
  rotatedAt?: number;
  transitionWindowMs?: number;
}

/**
 * يحدّد ما إذا كان المفتاح السابق ما زال ضمن النافذة الانتقالية في اللحظة `now`.
 *
 * يكون السابق مقبولاً فقط إذا:
 *   - الوضع `scheduled`، و
 *   - وُجد مفتاح سابق غير فارغ، و
 *   - طول النافذة موجب، و
 *   - لم تنقضِ النافذة بعد: `now <= rotatedAt + transitionWindowMs`.
 *
 * أي وضع `post-incident` يُرجِع دائماً `false` (لا قبول انتقالي) — AC 19.5.
 */
export function isPreviousKeyWithinTransitionWindow(
  config: JwtVerificationKeyConfig,
  now: number,
): boolean {
  if (config.mode !== 'scheduled') {
    return false;
  }
  const previous = config.previousPublicKey;
  if (typeof previous !== 'string' || previous.trim() === '') {
    return false;
  }
  const windowMs = config.transitionWindowMs ?? 0;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return false;
  }
  const rotatedAt = config.rotatedAt ?? 0;
  const windowEnd = rotatedAt + windowMs;
  // داخل النافذة شاملةً لحظة الانتهاء بالضبط.
  return now <= windowEnd;
}

/**
 * يحلّ مجموعة المفاتيح العامة الفعّالة للتحقق في اللحظة `now`.
 *
 * يحتوي الناتج دائماً على المفتاح الحالي، ويُضاف إليه المفتاح السابق **فقط** عند
 * كونه ضمن النافذة الانتقالية لوضع مجدول (`isPreviousKeyWithinTransitionWindow`).
 * المفتاح الحالي أولاً لتقليل عدد محاولات التحقق للرموز الحديثة (الغالبة).
 *
 * Validates: Requirements 19.2, 19.5
 */
export function resolveVerificationKeySet(
  config: JwtVerificationKeyConfig,
  now: number = Date.now(),
): string[] {
  const keys: string[] = [config.currentPublicKey];
  if (
    isPreviousKeyWithinTransitionWindow(config, now) &&
    typeof config.previousPublicKey === 'string'
  ) {
    keys.push(config.previousPublicKey);
  }
  return keys;
}

/**
 * يتحقّق من رمز JWT مقابل مجموعة من المفاتيح العامة، مُرجِعاً الحمولة المُفكّكة
 * عند أول مفتاح ينجح التحقق به. إن فشل التحقق بكل المفاتيح، يُعاد رمي آخر خطأ
 * (مثل `JsonWebTokenError`/`TokenExpiredError`) ليعامله المُستدعي كرفض.
 *
 * هذا غلاف رفيع حول `jwt.verify` يحافظ على سلوكه (التحقق من التوقيع والانتهاء)
 * مع دعم التحقق ضد عدة مفاتيح أثناء نافذة التدوير.
 *
 * @param token الرمز المراد التحقق منه.
 * @param publicKeys مجموعة المفاتيح العامة المُحلّاة (انظر `resolveVerificationKeySet`).
 * @param options خيارات `jsonwebtoken` (افتراضياً `{ algorithms: ['RS256'] }`).
 */
export function verifyJwtWithKeySet<T = jwt.JwtPayload | string>(
  token: string,
  publicKeys: readonly string[],
  options: jwt.VerifyOptions = { algorithms: ['RS256'] },
): T {
  if (publicKeys.length === 0) {
    throw new jwt.JsonWebTokenError('no verification keys available');
  }

  let lastError: unknown;
  for (const key of publicKeys) {
    try {
      return jwt.verify(token, key, options) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new jwt.JsonWebTokenError('jwt verification failed');
}

/**
 * مُساعد ملائم: يحلّ مجموعة المفاتيح من الإعداد ثم يتحقّق من الرمز ضدّها.
 * نقطة الإدماج المُفضَّلة في `src/middleware/auth.ts` و`src/ws/auth.ts`:
 * استبدال `jwt.verify(token, JWT_PUBLIC_KEY, ...)` بـ
 * `verifyJwtWithRotation(token, config, options)`.
 */
export function verifyJwtWithRotation<T = jwt.JwtPayload | string>(
  token: string,
  config: JwtVerificationKeyConfig,
  options: jwt.VerifyOptions = { algorithms: ['RS256'] },
  now: number = Date.now(),
): T {
  const keys = resolveVerificationKeySet(config, now);
  return verifyJwtWithKeySet<T>(token, keys, options);
}
