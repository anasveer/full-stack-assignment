import { NextRequest, NextResponse } from 'next/server';
import {
  requireAuthentication,
  handleGuardError,
  PermissionError,
} from '@/lib/server-guards';
import { Permission } from '@/lib/permissions';
import { createApiSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase-server';
import { estimatesService } from '@/lib/estimates-service';
import { transitionEstimateStatusSchema } from '@/lib/validation-schemas';
import { logger } from '@/lib/debug-logger';
import { EstimateStatus } from '@/lib/supabase';
import { hasPermission } from '@/lib/rbac';

interface RouteContext {
  params: Promise<{
    accountId: string;
    estimateId: string;
  }>;
}

/**
 * POST /api/accounts/[accountId]/estimates/[estimateId]/transition
 * Handle state lifecycle transitions (draft -> sent -> accepted | rejected)
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { accountId, estimateId } = await params;
    const supabase = createApiSupabaseClient(request);
    if (!supabase) {
      return NextResponse.json({ error: 'Database connection failed' }, { status: 500 });
    }

    const user = await requireAuthentication(request);
    const rawBody = await request.json();
    const parsed = transitionEstimateStatusSchema.safeParse(rawBody);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.format(),
        },
        { status: 400 },
      );
    }

    const { status: targetStatus, rejection_reason } = parsed.data;

    // Sending, returning to draft, and internal acceptance/rejection require
    // ESTIMATES_SEND. A client linked to this account may accept or reject
    // their own sent estimate without that permission.
    const canSend = await hasPermission(user, Permission.ESTIMATES_SEND, { accountId }, supabase);
    const isClientDecision = targetStatus === 'accepted' || targetStatus === 'rejected';
    const isAccountClient = user.is_client === true && user.client_account_id === accountId;

    if (!canSend && !(isClientDecision && isAccountClient)) {
      throw new PermissionError(
        'You do not have permission to change this estimate status',
        Permission.ESTIMATES_SEND,
        { accountId },
      );
    }

    // Clients intentionally cannot write through the RLS update policy (that
    // would let them tamper with financial columns). Authorization is enforced
    // above, then the narrow status update is performed with the service client.
    const writeClient =
      !canSend && isClientDecision && isAccountClient
        ? createAdminSupabaseClient() || supabase
        : supabase;

    const updated = await estimatesService.transitionStatus(
      accountId,
      estimateId,
      targetStatus as EstimateStatus,
      rejection_reason || undefined,
      writeClient,
    );

    return NextResponse.json({
      success: true,
      estimate: updated,
    });
  } catch (error: unknown) {
    logger.error('Error in POST estimate status transition', {}, error as Error);
    return handleGuardError(error);
  }
}
