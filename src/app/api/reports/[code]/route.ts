/**
 * ============================================================================
 * /api/reports/[code] — chạy một báo cáo đã định nghĩa trong database
 * ============================================================================
 *
 * ?format=csv  → tải file CSV
 * ?format=json → dữ liệu + câu SQL đã sinh (để người dùng kiểm tra)
 *
 * Câu SQL luôn được trả kèm. Một báo cáo ra số sai mà không ai kiểm chứng được
 * thì tệ hơn là không có báo cáo — người ta sẽ tin nó. Cho xem SQL là cách rẻ
 * nhất để một kế toán biết mình đang gộp cái gì.
 */

import { NextResponse } from 'next/server';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { eq, and } from 'drizzle-orm';
import { getDb, getPool } from '@/db/client';
import { policyVersions } from '@/db/schema';
import { reportParamsSchema } from '@/policy/report-params';
import { runReport, toCsv } from '@/engine/report';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    await requirePermission(req, 'report:read');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { code } = await ctx.params;
  const url = new URL(req.url);
  const at = url.searchParams.get('at') ?? new Date().toISOString().slice(0, 10);

  const db = getDb();
  const rows = await db
    .select()
    .from(policyVersions)
    .where(
      and(
        eq(policyVersions.kindCode, 'REPORT_DEF'),
        eq(policyVersions.code, code),
        eq(policyVersions.status, 'ACTIVE'),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: `Không có báo cáo ACTIVE nào mang mã '${code}'.` } },
      { status: 404 },
    );
  }

  const parsed = reportParamsSchema.safeParse(rows[0]!.params);
  if (!parsed.success) {
    // Định nghĩa trong database bị hỏng — có thể do ghi thẳng bằng SQL, bỏ
    // qua tầng validate. Không được im lặng chạy một định nghĩa sai.
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_DEFINITION',
          message: `Định nghĩa '${code}' v${rows[0]!.version} không hợp lệ.`,
          issues: parsed.error.issues,
        },
      },
      { status: 500 },
    );
  }

  const pool = getPool();
  try {
    const result = await runReport(parsed.data, async (sql, values) => {
      const r = await pool.query(sql, values);
      return r.rows as Record<string, unknown>[];
    });

    if (url.searchParams.get('format') === 'csv') {
      const csv = toCsv(result.columns, result.rows, parsed.data.currency);
      // BOM để Excel mở đúng tiếng Việt. Không có nó, Excel đoán Windows-1252
      // và mọi dấu tiếng Việt thành rác.
      return new Response('\uFEFF' + csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${code}.csv"`,
        },
      });
    }

    return NextResponse.json({
      code,
      version: rows[0]!.version,
      label: parsed.data.regimeLabel,
      appliedAt: at,
      sql: result.sql,
      params: result.values,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      durationMs: result.durationMs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'REPORT_FAILED', message: e instanceof Error ? e.message : String(e) } },
      { status: 400 },
    );
  }
}
