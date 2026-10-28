/**
 * Estimates Calculation & Service Engine
 *
 * Enforces strict financial calculation in minor units (BIGINT/integers).
 * Client-submitted totals are NEVER trusted; everything is computed and validated server-side.
 *
 * Calculation Rules:
 * 1. Line Item Amount: Math.round(quantity * unit_price_minor)
 * 2. Subtotal: sum(line_item.amount_minor)
 * 3. Discount: Math.round((subtotal_minor * discount_rate_basis_points) / 10000)
 * 4. Taxable Amount: Math.max(0, subtotal_minor - discount_minor)
 * 5. Tax: Math.round((taxable_amount * tax_rate_basis_points) / 10000)
 * 6. Total: taxable_amount + tax_minor
 */

import { AppSupabaseClient, Estimate, EstimateLineItem, EstimateStatus } from './supabase';
import { logger } from './debug-logger';

export interface RawLineItemInput {
  description: string;
  quantity: number;
  unit_price_minor: number;
}

export interface CalculatedLineItem extends RawLineItemInput {
  amount_minor: number;
  position: number;
}

export interface EstimateFinancials {
  subtotal_minor: number;
  discount_rate_basis_points: number;
  discount_minor: number;
  tax_rate_basis_points: number;
  tax_minor: number;
  total_minor: number;
  calculatedItems: CalculatedLineItem[];
}

export interface CreateEstimateInput {
  title: string;
  projectId?: string | null;
  currency?: string;
  validUntil?: string | null;
  notes?: string | null;
  terms?: string | null;
  discountRateBasisPoints?: number;
  taxRateBasisPoints?: number;
  lineItems: RawLineItemInput[];
  idempotencyKey?: string | null;
}

export interface UpdateEstimateInput {
  title?: string;
  projectId?: string | null;
  currency?: string;
  validUntil?: string | null;
  notes?: string | null;
  terms?: string | null;
  discountRateBasisPoints?: number;
  taxRateBasisPoints?: number;
  lineItems?: RawLineItemInput[];
}

export interface EstimateWithLineItems extends Estimate {
  line_items: EstimateLineItem[];
  project?: { id: string; name: string } | null;
  created_by_user?: { id: string; name: string; email: string } | null;
}

/**
 * Pure calculation function for deterministic, float-safe financial math
 */
export function calculateEstimateFinancials(
  items: RawLineItemInput[],
  discountRateBasisPoints: number = 0,
  taxRateBasisPoints: number = 0,
): EstimateFinancials {
  if (!items || items.length === 0) {
    throw new Error('Estimate must have at least one line item');
  }

  // Validate basis points (0 to 10000 -> 0.00% to 100.00%)
  const discountBps = Math.min(Math.max(0, Math.floor(discountRateBasisPoints || 0)), 10000);
  const taxBps = Math.min(Math.max(0, Math.floor(taxRateBasisPoints || 0)), 10000);

  let subtotal = 0;
  const calculatedItems: CalculatedLineItem[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const qty = Number(item.quantity);
    const unitPrice = Math.floor(Number(item.unit_price_minor));

    if (isNaN(qty) || qty <= 0) {
      throw new Error(`Line item #${i + 1} quantity must be greater than 0`);
    }
    if (isNaN(unitPrice) || unitPrice < 0) {
      throw new Error(`Line item #${i + 1} unit price cannot be negative`);
    }

    // Multiply quantity with minor unit and round cleanly
    const itemAmount = Math.round(qty * unitPrice);
    subtotal += itemAmount;

    calculatedItems.push({
      description: item.description?.trim() || `Item ${i + 1}`,
      quantity: qty,
      unit_price_minor: unitPrice,
      amount_minor: itemAmount,
      position: i,
    });
  }

  // Discount calculation
  const discountMinor = Math.round((subtotal * discountBps) / 10000);
  const taxableAmount = Math.max(0, subtotal - discountMinor);

  // Tax calculation
  const taxMinor = Math.round((taxableAmount * taxBps) / 10000);

  // Grand total
  const totalMinor = taxableAmount + taxMinor;

  return {
    subtotal_minor: subtotal,
    discount_rate_basis_points: discountBps,
    discount_minor: discountMinor,
    tax_rate_basis_points: taxBps,
    tax_minor: taxMinor,
    total_minor: totalMinor,
    calculatedItems,
  };
}

/**
 * Currencies whose minor-unit exponent differs from the common 2-decimal
 * default. Kept explicit so calculations stay deterministic even when the
 * runtime ICU data is incomplete.
 */
const CURRENCY_MINOR_UNIT_OVERRIDES: Record<string, number> = {
  // Zero-decimal currencies
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal currencies
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/**
 * Resolve how many decimal places a currency's minor unit uses.
 * e.g. USD -> 2, JPY -> 0, KWD -> 3.
 */
export function getCurrencyMinorUnitExponent(currency: string = 'USD'): number {
  const code = (currency || 'USD').toUpperCase();
  const override = CURRENCY_MINOR_UNIT_OVERRIDES[code];
  if (override !== undefined) return override;

  try {
    const resolved = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    return resolved ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Convert a major-unit amount (e.g. 1500.5) into integer minor units,
 * respecting the currency's exponent (150050 for USD, 1500500 for KWD).
 */
export function toMinorUnits(amount: number, currency: string = 'USD'): number {
  const exponent = getCurrencyMinorUnitExponent(currency);
  return Math.round((Number(amount) || 0) * 10 ** exponent);
}

/**
 * Convert integer minor units back into a major-unit number.
 */
export function fromMinorUnits(amountMinor: number, currency: string = 'USD'): number {
  const exponent = getCurrencyMinorUnitExponent(currency);
  return (Number(amountMinor) || 0) / 10 ** exponent;
}

/**
 * Format minor units into human readable currency display, aware of the
 * currency's minor-unit exponent (e.g. 150000 USD -> "$1,500.00",
 * 150000 JPY -> "¥150,000").
 */
export function formatMinorUnits(amountMinor: number, currency: string = 'USD'): string {
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(fromMinorUnits(amountMinor, code));
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(fromMinorUnits(amountMinor, 'USD'));
  }
}

/**
 * Pure lifecycle predicate used by both the service and the unit tests.
 * Draft -> Sent -> Accepted | Rejected (Sent may also be returned to Draft).
 */
export function isValidEstimateTransition(
  currentStatus: EstimateStatus,
  nextStatus: EstimateStatus,
): boolean {
  if (currentStatus === 'draft') return nextStatus === 'sent';
  if (currentStatus === 'sent') {
    return nextStatus === 'accepted' || nextStatus === 'rejected' || nextStatus === 'draft';
  }
  // accepted and rejected are terminal
  return false;
}

export class EstimatesService {
  /**
   * Generate next sequential estimate number for an account
   * e.g. EST-2026-0001
   *
   * Uses the highest existing suffix instead of COUNT so that soft-deleted
   * records and concurrent inserts cannot cause duplicate numbers.
   */
  async generateEstimateNumber(accountId: string, supabase: AppSupabaseClient): Promise<string> {
    const currentYear = new Date().getFullYear();
    const prefix = `EST-${currentYear}-`;

    const { data, error } = await supabase
      .from('estimates')
      .select('estimate_number')
      .eq('account_id', accountId)
      .like('estimate_number', `${prefix}%`);

    if (error) {
      logger.error('Failed to list estimates for numbering', { accountId }, error);
    }

    let maxSequence = 0;
    for (const row of data || []) {
      const value = (row as { estimate_number?: string }).estimate_number;
      if (!value || !value.startsWith(prefix)) continue;
      const parsed = Number.parseInt(value.slice(prefix.length), 10);
      if (Number.isFinite(parsed) && parsed > maxSequence) {
        maxSequence = parsed;
      }
    }

    return `${prefix}${String(maxSequence + 1).padStart(4, '0')}`;
  }

  /**
   * List estimates for an account with optional status filtering
   */
  async getEstimates(
    accountId: string,
    options: {
      status?: EstimateStatus;
      projectId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
    supabase: AppSupabaseClient,
  ): Promise<{ data: EstimateWithLineItems[]; count: number }> {
    let query = supabase
      .from('estimates')
      .select(
        `
        *,
        line_items:estimate_line_items(*),
        project:projects(id, name),
        created_by_user:user_profiles!created_by(id, name, email)
      `,
        { count: 'exact' },
      )
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (options.status) {
      query = query.eq('status', options.status);
    }
    if (options.projectId) {
      query = query.eq('project_id', options.projectId);
    }
    if (options.search) {
      // Strip PostgREST filter delimiters to prevent filter injection, then
      // apply the search only if something meaningful remains.
      const safeSearch = options.search.replace(/[(),]/g, ' ').trim().slice(0, 100);
      if (safeSearch) {
        query = query.or(
          `title.ilike.%${safeSearch}%,estimate_number.ilike.%${safeSearch}%`,
        );
      }
    }

    if (options.limit) {
      query = query.limit(options.limit);
    }
    if (options.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 20) - 1);
    }

    const { data, count, error } = await query;

    if (error) {
      logger.error('Error fetching estimates', { accountId, options }, error);
      throw new Error(`Failed to fetch estimates: ${error.message}`);
    }

    return {
      data: (data || []) as unknown as EstimateWithLineItems[],
      count: count || 0,
    };
  }

  /**
   * Get a single estimate by ID with tenant validation
   */
  async getEstimateById(
    accountId: string,
    estimateId: string,
    supabase: AppSupabaseClient,
  ): Promise<EstimateWithLineItems | null> {
    const { data, error } = await supabase
      .from('estimates')
      .select(
        `
        *,
        line_items:estimate_line_items(*),
        project:projects(id, name),
        created_by_user:user_profiles!created_by(id, name, email)
      `,
      )
      .eq('id', estimateId)
      .eq('account_id', accountId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) {
      logger.error('Error fetching estimate by id', { accountId, estimateId }, error);
      throw new Error(`Failed to fetch estimate: ${error.message}`);
    }

    if (!data) return null;

    // Sort line items by position
    if (data.line_items && Array.isArray(data.line_items)) {
      data.line_items.sort((a: any, b: any) => a.position - b.position);
    }

    return data as unknown as EstimateWithLineItems;
  }

  /**
   * Create an estimate with Idempotency check and server-side calculated totals
   */
  async createEstimate(
    accountId: string,
    input: CreateEstimateInput,
    userId: string | null,
    supabase: AppSupabaseClient,
  ): Promise<{ estimate: EstimateWithLineItems; isDuplicate: boolean }> {
    // 1. Idempotency Check
    if (input.idempotencyKey) {
      const { data: existing } = await supabase
        .from('estimates')
        .select('id')
        .eq('account_id', accountId)
        .eq('idempotency_key', input.idempotencyKey)
        .is('deleted_at', null)
        .maybeSingle();

      if (existing) {
        logger.info('Idempotent request matched existing estimate', {
          accountId,
          estimateId: existing.id,
          idempotencyKey: input.idempotencyKey,
        });
        const existingFull = await this.getEstimateById(accountId, existing.id, supabase);
        if (existingFull) {
          return { estimate: existingFull, isDuplicate: true };
        }
      }
    }

    // 2. Perform server-side calculation
    const financials = calculateEstimateFinancials(
      input.lineItems,
      input.discountRateBasisPoints,
      input.taxRateBasisPoints,
    );

    // 3. Insert the estimate. Retry on estimate-number collisions; replay on
    //    idempotency-key collisions (two concurrent requests with the same key).
    const maxAttempts = 5;
    let estimateNumber = await this.generateEstimateNumber(accountId, supabase);
    let createdEstimate: Estimate | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data: inserted, error: insertError } = await supabase
        .from('estimates')
        .insert({
          account_id: accountId,
          project_id: input.projectId || null,
          estimate_number: estimateNumber,
          title: input.title.trim(),
          status: 'draft',
          currency: (input.currency || 'USD').toUpperCase(),
          subtotal_minor: financials.subtotal_minor,
          discount_rate_basis_points: financials.discount_rate_basis_points,
          discount_minor: financials.discount_minor,
          tax_rate_basis_points: financials.tax_rate_basis_points,
          tax_minor: financials.tax_minor,
          total_minor: financials.total_minor,
          notes: input.notes?.trim() || null,
          terms: input.terms?.trim() || null,
          valid_until: input.validUntil || null,
          created_by: userId,
          idempotency_key: input.idempotencyKey || null,
        })
        .select()
        .single();

      if (!insertError && inserted) {
        createdEstimate = inserted as Estimate;
        break;
      }

      const errorMessage = insertError?.message || '';
      const isUniqueViolation = insertError?.code === '23505';

      // CONCURRENT IDEMPOTENT RETRY: another request already created it.
      if (
        isUniqueViolation &&
        input.idempotencyKey &&
        errorMessage.includes('idempotency') &&
        !errorMessage.includes('account_number')
      ) {
        const { data: existing } = await supabase
          .from('estimates')
          .select('id')
          .eq('account_id', accountId)
          .eq('idempotency_key', input.idempotencyKey)
          .is('deleted_at', null)
          .maybeSingle();

        if (existing) {
          const existingFull = await this.getEstimateById(accountId, existing.id, supabase);
          if (existingFull) {
            logger.info('Idempotent request resolved after concurrent insert', {
              accountId,
              estimateId: existing.id,
              idempotencyKey: input.idempotencyKey,
            });
            return { estimate: existingFull, isDuplicate: true };
          }
        }
      }

      // ESTIMATE NUMBER COLLISION: regenerate the next number and retry.
      if (isUniqueViolation && errorMessage.includes('account_number')) {
        estimateNumber = await this.generateEstimateNumber(accountId, supabase);
        continue;
      }

      logger.error('Failed to insert estimate', { accountId, input, attempt }, insertError);
      throw new Error(`Failed to create estimate: ${insertError?.message || 'Unknown error'}`);
    }

    if (!createdEstimate) {
      throw new Error('Failed to create estimate after multiple attempts due to numbering conflicts');
    }

    const estimateId = createdEstimate.id;

    // 4. Insert line items
    const lineItemRows = financials.calculatedItems.map((item) => ({
      estimate_id: estimateId,
      account_id: accountId,
      description: item.description,
      quantity: item.quantity,
      unit_price_minor: item.unit_price_minor,
      amount_minor: item.amount_minor,
      position: item.position,
    }));

    const { error: lineItemError } = await supabase
      .from('estimate_line_items')
      .insert(lineItemRows);

    if (lineItemError) {
      logger.error('Failed to insert line items', { estimateId }, lineItemError);
      // Hard deletes are forbidden for audit integrity, so roll back by
      // soft-deleting the incomplete estimate and releasing its idempotency key.
      const { error: cleanupError } = await supabase
        .from('estimates')
        .update({ deleted_at: new Date().toISOString(), idempotency_key: null })
        .eq('id', estimateId)
        .eq('account_id', accountId);

      if (cleanupError) {
        logger.error(
          'Failed to soft-delete incomplete estimate after line item error',
          { estimateId },
          cleanupError,
        );
      }

      throw new Error(`Failed to create line items: ${lineItemError.message}`);
    }

    const fullEstimate = await this.getEstimateById(accountId, estimateId, supabase);
    if (!fullEstimate) {
      throw new Error('Failed to retrieve newly created estimate');
    }

    return { estimate: fullEstimate, isDuplicate: false };
  }

  /**
   * Update an existing draft estimate
   * (Estimates in sent, accepted, or rejected state cannot have line items modified)
   */
  async updateEstimate(
    accountId: string,
    estimateId: string,
    input: UpdateEstimateInput,
    supabase: AppSupabaseClient,
  ): Promise<EstimateWithLineItems> {
    const existing = await this.getEstimateById(accountId, estimateId, supabase);
    if (!existing) {
      throw new Error('Estimate not found');
    }

    if (existing.status !== 'draft') {
      throw new Error(
        `Cannot edit estimate in "${existing.status}" status. Only draft estimates can be edited.`,
      );
    }

    // Prepare financials if line items or rates updated
    const lineItemsToUse = input.lineItems || existing.line_items;
    const discountBps =
      input.discountRateBasisPoints !== undefined
        ? input.discountRateBasisPoints
        : existing.discount_rate_basis_points;
    const taxBps =
      input.taxRateBasisPoints !== undefined
        ? input.taxRateBasisPoints
        : existing.tax_rate_basis_points;

    const financials = calculateEstimateFinancials(lineItemsToUse, discountBps, taxBps);

    // Update estimate row
    const { error: updateError } = await supabase
      .from('estimates')
      .update({
        title: input.title !== undefined ? input.title.trim() : existing.title,
        project_id: input.projectId !== undefined ? input.projectId : existing.project_id,
        currency: input.currency !== undefined ? input.currency.toUpperCase() : existing.currency,
        subtotal_minor: financials.subtotal_minor,
        discount_rate_basis_points: financials.discount_rate_basis_points,
        discount_minor: financials.discount_minor,
        tax_rate_basis_points: financials.tax_rate_basis_points,
        tax_minor: financials.tax_minor,
        total_minor: financials.total_minor,
        notes: input.notes !== undefined ? input.notes?.trim() : existing.notes,
        terms: input.terms !== undefined ? input.terms?.trim() : existing.terms,
        valid_until: input.validUntil !== undefined ? input.validUntil : existing.valid_until,
      })
      .eq('id', estimateId)
      .eq('account_id', accountId);

    if (updateError) {
      logger.error('Failed to update estimate', { accountId, estimateId }, updateError);
      throw new Error(`Failed to update estimate: ${updateError.message}`);
    }

    // Replace line items if new ones provided
    if (input.lineItems) {
      // Delete old line items
      const { error: deleteError } = await supabase
        .from('estimate_line_items')
        .delete()
        .eq('estimate_id', estimateId)
        .eq('account_id', accountId);

      if (deleteError) {
        logger.error('Failed to clear old line items', { estimateId }, deleteError);
        throw new Error(`Failed to update line items: ${deleteError.message}`);
      }

      // Insert fresh calculated line items
      const lineItemRows = financials.calculatedItems.map((item) => ({
        estimate_id: estimateId,
        account_id: accountId,
        description: item.description,
        quantity: item.quantity,
        unit_price_minor: item.unit_price_minor,
        amount_minor: item.amount_minor,
        position: item.position,
      }));

      const { error: lineItemError } = await supabase
        .from('estimate_line_items')
        .insert(lineItemRows);

      if (lineItemError) {
        logger.error('Failed to update line items', { estimateId }, lineItemError);

        // Roll back to the previous line items and financials so a failed
        // update cannot leave the estimate half-written.
        const previousRows = (existing.line_items || []).map((item) => ({
          id: item.id,
          estimate_id: item.estimate_id,
          account_id: item.account_id,
          description: item.description,
          quantity: item.quantity,
          unit_price_minor: item.unit_price_minor,
          amount_minor: item.amount_minor,
          position: item.position,
          created_at: item.created_at,
          updated_at: item.updated_at,
        }));

        if (previousRows.length > 0) {
          const { error: restoreError } = await supabase
            .from('estimate_line_items')
            .insert(previousRows);
          if (restoreError) {
            logger.error(
              'Failed to restore line items after a failed update',
              { estimateId },
              restoreError,
            );
          }
        }

        await supabase
          .from('estimates')
          .update({
            subtotal_minor: existing.subtotal_minor,
            discount_rate_basis_points: existing.discount_rate_basis_points,
            discount_minor: existing.discount_minor,
            tax_rate_basis_points: existing.tax_rate_basis_points,
            tax_minor: existing.tax_minor,
            total_minor: existing.total_minor,
          })
          .eq('id', estimateId)
          .eq('account_id', accountId);

        throw new Error(`Failed to update line items: ${lineItemError.message}`);
      }
    }

    const updated = await this.getEstimateById(accountId, estimateId, supabase);
    if (!updated) {
      throw new Error('Failed to retrieve updated estimate');
    }
    return updated;
  }

  /**
   * Transition lifecycle state: draft -> sent -> accepted | rejected
   */
  async transitionStatus(
    accountId: string,
    estimateId: string,
    newStatus: EstimateStatus,
    reason?: string,
    supabase?: AppSupabaseClient,
  ): Promise<EstimateWithLineItems> {
    if (!supabase) throw new Error('Supabase client is required');

    const estimate = await this.getEstimateById(accountId, estimateId, supabase);
    if (!estimate) {
      throw new Error('Estimate not found');
    }

    const currentStatus = estimate.status;

    // Validate lifecycle transitions with the shared pure predicate.
    if (!isValidEstimateTransition(currentStatus, newStatus)) {
      if (currentStatus === 'draft') {
        throw new Error(
          `Cannot transition draft estimate directly to "${newStatus}". Must be "sent" first.`,
        );
      }
      if (currentStatus === 'sent') {
        throw new Error(
          `Sent estimate can only transition to "accepted", "rejected", or returned to "draft". Received "${newStatus}".`,
        );
      }
      throw new Error(
        `Estimate is already finalized as "${currentStatus}" and cannot be changed.`,
      );
    }

    const updatePayload: Record<string, any> = {
      status: newStatus,
    };

    const now = new Date().toISOString();
    if (newStatus === 'sent') {
      updatePayload.sent_at = now;
    } else if (newStatus === 'accepted') {
      updatePayload.accepted_at = now;
    } else if (newStatus === 'rejected') {
      updatePayload.rejected_at = now;
      updatePayload.rejection_reason = reason?.trim() || null;
    } else if (newStatus === 'draft') {
      // Returning a sent estimate to draft clears the dispatch timestamp.
      updatePayload.sent_at = null;
    }

    const { error } = await supabase
      .from('estimates')
      .update(updatePayload)
      .eq('id', estimateId)
      .eq('account_id', accountId);

    if (error) {
      logger.error('Failed to transition estimate status', { accountId, estimateId, newStatus }, error);
      throw new Error(`Failed to transition estimate status: ${error.message}`);
    }

    const updated = await this.getEstimateById(accountId, estimateId, supabase);
    if (!updated) {
      throw new Error('Failed to retrieve updated estimate after transition');
    }
    return updated;
  }
}

export const estimatesService = new EstimatesService();
