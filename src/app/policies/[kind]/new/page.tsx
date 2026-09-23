'use client';

/**
 * ============================================================================
 * TẠO PHIÊN BẢN CHÍNH SÁCH MỚI
 * ============================================================================
 *
 * Form tham số KHÔNG được viết tay cho thuế. Nó được SINH RA từ
 * kind.paramsSchema (JSON Schema lưu trong DB) bằng <SchemaForm />.
 *
 * Nghĩa là khi thêm loại chính sách mới (BHXH, ngưỡng duyệt…), chỉ cần đăng ký
 * một JSON Schema — màn hình này tự hiển thị đúng form cho loại đó.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  Field,
  inputCls,
} from '@/components/ui';
import { SchemaForm, defaultsFromSchema, type JsonSchema } from '@/components/schema-form';

type Json = Record<string, unknown>;

interface Issue {
  path: (string | number)[];
  message: string;
}

export default function NewVersionPage() {
  const { kind } = useParams<{ kind: string }>();
  const router = useRouter();

  const [schema, setSchema] = useState<JsonSchema | null>(null);
  const [kindName, setKindName] = useState('');
  const [params, setParams] = useState<Json>({});

  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [legalBasis, setLegalBasis] = useState('');
  const [note, setNote] = useState('');
  const [activateNow, setActivateNow] = useState(true);
  const [reason, setReason] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Nạp JSON Schema của loại chính sách
  useEffect(() => {
    if (!kind) return;
    fetch(`/api/policies/${encodeURIComponent(kind)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        const s = (d.kind?.paramsSchema ?? null) as JsonSchema | null;
        if (!s) throw new Error('Loại chính sách này chưa có JSON Schema');
        setSchema(s);
        setKindName(d.kind?.nameVi ?? kind);
        setParams(defaultsFromSchema(s) as Json);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [kind]);

  const submit = useCallback(async () => {
    if (!schema) return;
    setBusy(true);
    setError(null);
    setIssues([]);

    if (!effectiveFrom) {
      setError('Phải chọn ngày bắt đầu hiệu lực.');
      setBusy(false);
      return;
    }

    try {
      const res = await fetch(`/api/policies/${encodeURIComponent(kind)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          effectiveFrom,
          effectiveTo: effectiveTo || null,
          legalBasis: legalBasis || null,
          note: note || null,
          params,
          actor: 'web-user',
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        const details = body?.error?.details;
        if (Array.isArray(details) && details.length > 0) {
          setIssues(
            details.map((d: { path?: unknown[]; message?: string }) => ({
              path: (d.path ?? []) as (string | number)[],
              message: d.message ?? 'Không hợp lệ',
            })),
          );
        }
        setError(body?.error?.message ?? `Lỗi ${res.status}`);
        setBusy(false);
        return;
      }

      const versionId: string = body?.data?.versionId;

      if (activateNow && versionId) {
        const act = await fetch(
          `/api/policies/${encodeURIComponent(kind)}/versions/${versionId}/activate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actor: 'web-user', reason: reason || null }),
          },
        );
        const actBody = await act.json();
        if (!act.ok) {
          setError(
            `Đã tạo phiên bản nhưng KHÔNG kích hoạt được: ${actBody?.error?.message ?? act.status}. ` +
              `Bạn có thể kích hoạt sau từ trang chi tiết.`,
          );
          setBusy(false);
          return;
        }
        const warnings: string[] = actBody?.data?.warnings ?? [];
        if (warnings.length > 0) {
          setError(`Đã kích hoạt, nhưng có cảnh báo: ${warnings.join(' · ')}`);
          setBusy(false);
          setTimeout(() => router.push(`/policies/${encodeURIComponent(kind)}`), 3500);
          return;
        }
      }

      router.push(`/policies/${encodeURIComponent(kind)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
      setBusy(false);
    }
  }, [schema, kind, effectiveFrom, effectiveTo, legalBasis, note, params, activateNow, reason, router]);

  if (loadError) {
    return (
      <div className="space-y-4">
        <a href="/" className="text-xs text-[var(--muted)] hover:underline">← Quay lại</a>
        <Alert tone="danger">{loadError}</Alert>
      </div>
    );
  }

  if (!schema) {
    return <p className="text-sm text-[var(--muted)]">Đang tải schema…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <a href={`/policies/${encodeURIComponent(kind)}`} className="text-xs text-[var(--muted)] hover:underline">
          ← {kindName}
        </a>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Phiên bản mới</h1>
        <p className="mt-1.5 text-sm text-[var(--muted)]">
          Form bên dưới được <strong>tự sinh từ JSON Schema</strong> của loại{' '}
          <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-xs">{kind}</code> —
          không phải form viết tay cho riêng loại này.
        </p>
      </div>

      {error && (
        <Alert tone={issues.length > 0 ? 'danger' : 'warn'}>
          <div className="font-medium">{error}</div>
          {issues.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {issues.map((i, idx) => (
                <li key={idx}>
                  <code className="rounded bg-[#00000040] px-1">
                    {i.path.length > 0 ? i.path.join('.') : '(gốc)'}
                  </code>{' '}
                  — {i.message}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <Card title="Khoảng hiệu lực" subtitle="Engine chọn phiên bản theo ngày của kỳ lương">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hiệu lực từ" hint="Tính cả ngày này">
            <input
              type="date"
              className={inputCls}
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
          <Field label="Đến" hint="Để trống = còn hiệu lực đến nay. Không tính ngày này.">
            <input
              type="date"
              className={inputCls}
              value={effectiveTo}
              onChange={(e) => setEffectiveTo(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Căn cứ pháp lý"
              hint="Bắt buộc nên ghi: khi cơ quan thuế hỏi, phải chỉ ra được văn bản nào"
            >
              <input
                type="text"
                className={inputCls}
                value={legalBasis}
                onChange={(e) => setLegalBasis(e.target.value)}
                placeholder="VD: Nghị quyết 110/2025/UBTVQH15"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Ghi chú">
              <input
                type="text"
                className={inputCls}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card
        title="Tham số"
        subtitle="Form sinh tự động từ JSON Schema — validate bằng Zod ở server trước khi ghi"
      >
        <SchemaForm
          schema={schema}
          value={params as Record<string, never>}
          onChange={(v) => setParams(v as Json)}
        />
      </Card>

      <Card title="Kích hoạt">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={activateNow}
            onChange={(e) => setActivateNow(e.target.checked)}
            className="mt-1 h-4 w-4 accent-[var(--accent)]"
          />
          <span className="text-sm">
            <span className="font-medium">Kích hoạt ngay sau khi tạo</span>
            <span className="mt-0.5 block text-xs text-[var(--muted)]">
              Phiên bản đang chồng lấn sẽ được tự động cắt khoảng hiệu lực hoặc archive.
              Nếu bỏ chọn, phiên bản ở trạng thái DRAFT và engine sẽ KHÔNG đọc.
            </span>
          </span>
        </label>
        {activateNow && (
          <div className="mt-4">
            <Field label="Lý do kích hoạt" hint="Ghi vào audit log">
              <input
                type="text"
                className={inputCls}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="VD: Áp dụng theo Nghị quyết mới"
              />
            </Field>
          </div>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Đang lưu…' : activateNow ? 'Tạo và kích hoạt' : 'Tạo bản nháp'}
        </Button>
        <Button variant="ghost" onClick={() => router.back()} disabled={busy}>
          Huỷ
        </Button>
        <span className="text-xs text-[var(--muted)]">
          Tham số được validate ở server — bậc thuế phải tăng dần, số trừ nhanh phải khớp công thức.
        </span>
      </div>
    </div>
  );
}
