/**
 * جرد المسار↔الصلاحية (Route↔Permission inventory).
 *
 * يَعُدّ هذا المنطق مكدّس مسارات Express ويربط كل مسار مُغيِّر/قارئ بزوج
 * الوحدة-والإجراء (module-plus-action) الذي يُنفِّذه `checkPermission` عليه،
 * أو يُعلِن صراحةً عدم وجود فحص صلاحية (`permission === null`). ثم تُرجِع
 * `findAuthorizationGaps` تماماً المسارات المُغيِّرة للحالة التي لا تحمل فحص
 * صلاحية — أي فجوات التفويض الواجب إغلاقها قبل الإطلاق.
 *
 * المكوّن: المنطقة (هـ) في design.md.
 * Reference: design.md "هـ. إضافات checkPermission في fraud.ts + مولّد جرد المسار↔الصلاحية"
 * Requirements: 6.4, 6.5
 *
 * ── كيفية استخراج بيانات الصلاحية ──────────────────────────────────────────
 * مصنع `checkPermission(module, action)` في `src/middleware/auth.ts` يُغلِّف
 * (closure) قيمتَي `module`/`action` لكن لا يكشفهما على الوسيط المُعاد، لذا لا
 * يمكن استنباطهما من المكدّس وحده. لذلك يوسم المصنع الوسيط المُعاد بخاصية بيانات
 * وصفية ثابتة المفتاح ({@link ROUTE_PERMISSION_METADATA_KEY})، ويقرأ هذا الجرد
 * تلك الخاصية من كل مُعالِج (handler) في مكدّس المسار. أيُّ مسار لا يحمل أيٌّ من
 * مُعالِجاته هذه الخاصية يُعَدّ بلا فحص صلاحية (`permission === null`).
 */

import type { Express } from 'express';
import type { RoutePermissionEntry } from '../launch/types.js';

/**
 * المفتاح الذي يوسم به مصنع `checkPermission` الوسيطَ المُعاد ببيانات الصلاحية،
 * ويقرؤه هذا الجرد لاستخراج زوج الوحدة-والإجراء من مكدّس المسار.
 */
export const ROUTE_PERMISSION_METADATA_KEY = '__routePermission' as const;

/** أساليب HTTP المُغيِّرة للحالة (mutating). */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type PermissionMeta = { module: string; action: string };

/**
 * يستخرج بيانات الصلاحية من مُعالِج إن كان موسوماً بها بواسطة مصنع
 * `checkPermission`؛ وإلا يُرجِع `null`.
 */
function extractPermissionMeta(handler: unknown): PermissionMeta | null {
  if (typeof handler !== 'function' && (typeof handler !== 'object' || handler === null)) {
    return null;
  }
  const meta = (handler as Record<string, unknown>)[ROUTE_PERMISSION_METADATA_KEY];
  if (meta && typeof meta === 'object') {
    const { module, action } = meta as Record<string, unknown>;
    if (typeof module === 'string' && typeof action === 'string') {
      return { module, action };
    }
  }
  return null;
}

/**
 * يحاول استرجاع مسار التركيب (mount path) لطبقة موجِّه فرعي من تعبيرها النمطي.
 * يُرجِع سلسلة فارغة عند تعذّر الاستنتاج أو عند التركيب على الجذر `/`، بحيث يبقى
 * الجرد مكتملاً (مدخل واحد لكل مسار) حتى لو تعذّرت إعادة بناء البادئة الكاملة.
 */
function getLayerMountPath(layer: any): string {
  // بعض إصدارات Express تحفظ المسار الأصلي مباشرةً على الطبقة.
  if (typeof layer?.path === 'string') {
    return normalizeSegment(layer.path);
  }

  const regexp: RegExp | undefined = layer?.regexp;
  if (!regexp) return '';
  // موجِّه مركّب على الجذر يطابق كل شيء.
  if ((regexp as any).fast_slash) return '';

  const source = regexp.source;
  // النمط المعتاد الذي يولّده Express لبادئة التركيب:
  //   ^\/segment\/?(?=\/|$)  أو  ^\\/segment\\/?$
  const match = source
    .replace('\\/?(?=\\/|$)', '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/');
  // إزالة أي بقايا تعبيرات نمطية غير قابلة للاسترجاع بأمان.
  if (/[()?:*+\[\]]/.test(match)) {
    return '';
  }
  return normalizeSegment(match);
}

/** يُطبّع مقطع مسار بإزالة الشرطة المائلة الزائدة في الطرفين وتوحيد البادئة. */
function normalizeSegment(segment: string): string {
  if (!segment) return '';
  let s = segment.trim();
  if (s === '/' || s === '') return '';
  s = s.replace(/\/+$/, ''); // إزالة الشرطات الزائدة في النهاية
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

/** يدمج بادئة التركيب مع مسار المسار الفرعي في مسار كامل مُطبَّع. */
function joinPaths(base: string, path: string): string {
  const left = base.replace(/\/+$/, '');
  const right = path.startsWith('/') ? path : `/${path}`;
  const joined = `${left}${right}`.replace(/\/{2,}/g, '/');
  if (joined.length > 1) {
    return joined.replace(/\/$/, '');
  }
  return joined;
}

/**
 * يبني مدخل جرد واحداً من بيانات مسار (method + path + permission).
 */
function buildEntry(method: string, path: string, permission: PermissionMeta | null): RoutePermissionEntry {
  const upperMethod = method.toUpperCase();
  const mutating = MUTATING_METHODS.has(upperMethod);
  return {
    method: upperMethod,
    path: path === '' ? '/' : path,
    permission,
    mutating,
    isGap: mutating && permission === null,
  };
}

/**
 * يَعُدّ طبقات مكدّس Express (المسارات والموجِّهات الفرعية) بشكل تكراري ويجمع
 * مدخلات الجرد، مع تمرير بادئة التركيب الجارية.
 */
function collectFromStack(stack: any[], basePath: string, entries: RoutePermissionEntry[]): void {
  if (!Array.isArray(stack)) return;

  for (const layer of stack) {
    if (!layer) continue;

    // (1) طبقة مسار مُسجَّل مباشرةً.
    if (layer.route) {
      const route = layer.route;
      const routePath = joinPaths(basePath, normalizeSegment(route.path ?? ''));

      // البحث عن مُعالِج موسوم ببيانات صلاحية ضمن مكدّس المسار.
      let permission: PermissionMeta | null = null;
      const routeStack: any[] = Array.isArray(route.stack) ? route.stack : [];
      for (const handlerLayer of routeStack) {
        const meta = extractPermissionMeta(handlerLayer?.handle);
        if (meta) {
          permission = meta;
          break;
        }
      }

      // أساليب HTTP لهذا المسار (كائن مثل { get: true, post: true }).
      const methods: Record<string, boolean> = route.methods ?? {};
      const methodNames = Object.keys(methods).filter((m) => methods[m] && m !== '_all');
      if (methodNames.length === 0) {
        // مسار بلا أسلوب صريح — يُسجَّل كمدخل بأسلوب غير معروف للحفاظ على الاكتمال.
        entries.push(buildEntry('ALL', routePath, permission));
        continue;
      }
      for (const m of methodNames) {
        entries.push(buildEntry(m, routePath, permission));
      }
      continue;
    }

    // (2) طبقة موجِّه فرعي (sub-router) — نزول تكراري.
    const handle = layer.handle;
    if (handle && Array.isArray(handle.stack)) {
      const mountPath = getLayerMountPath(layer);
      collectFromStack(handle.stack, joinPaths(basePath, mountPath), entries);
    }
  }
}

/**
 * يبني جرد المسار↔الصلاحية لتطبيق Express: مدخل واحد لكل مسار/أسلوب مُسجَّل،
 * يربطه إمّا بزوج الوحدة-والإجراء أو بـ `null` صراحةً عند غياب فحص الصلاحية.
 *
 * Validates: Requirements 6.4
 */
export function buildRoutePermissionInventory(app: Express): RoutePermissionEntry[] {
  const entries: RoutePermissionEntry[] = [];

  // Express 5 يكشف الموجِّه عبر `app.router`؛ وإصدارات أقدم عبر `app._router`.
  const appAny = app as unknown as { router?: { stack?: any[] }; _router?: { stack?: any[] } };
  const stack = appAny.router?.stack ?? appAny._router?.stack;

  if (Array.isArray(stack)) {
    collectFromStack(stack, '', entries);
  }

  return entries;
}

/**
 * يُرجِع تماماً المسارات المُغيِّرة للحالة التي لا تحمل فحص صلاحية (`isGap`)،
 * أي فجوات التفويض الواجب إغلاقها قبل الإطلاق — لا أكثر ولا أقل.
 *
 * Validates: Requirements 6.5
 */
export function findAuthorizationGaps(inventory: RoutePermissionEntry[]): RoutePermissionEntry[] {
  return inventory.filter((entry) => entry.isGap);
}
