-- =============================================================
-- ESTIMATES & ESTIMATE LINE ITEMS  (Revenue & Billing module)
-- Additive, zero-downtime migration for databases that were
-- created before the estimates feature existed.
--
-- Run this AFTER the base schema (accounts, projects, user_profiles,
-- account_members and update_updated_at_column must already exist).
-- Safe to re-run: every statement is idempotent.
-- =============================================================

-- 1. Core tables -------------------------------------------------

CREATE TABLE IF NOT EXISTS estimates (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id                 UUID REFERENCES projects(id) ON DELETE SET NULL,
  estimate_number            TEXT NOT NULL,
  title                      TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  currency                   TEXT NOT NULL DEFAULT 'USD',
  subtotal_minor             BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_rate_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (discount_rate_basis_points >= 0 AND discount_rate_basis_points <= 10000),
  discount_minor             BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_basis_points      INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_basis_points >= 0 AND tax_rate_basis_points <= 10000),
  tax_minor                  BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor                BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes                      TEXT,
  terms                      TEXT,
  valid_until                DATE,
  sent_at                    TIMESTAMPTZ,
  accepted_at                TIMESTAMPTZ,
  rejected_at                TIMESTAMPTZ,
  rejection_reason           TEXT,
  created_by                 UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  idempotency_key            TEXT,
  deleted_at                 TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_estimates_account_number UNIQUE (account_id, estimate_number)
);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id       UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  quantity          NUMERIC(12, 4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor  BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor >= 0),
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Patches for databases created with an older estimates table --

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- The original schema made idempotency_key globally UNIQUE. Idempotency
-- must be scoped per account, so drop the old constraint/index first.
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_idempotency_key_key;
DROP INDEX IF EXISTS idx_estimates_idempotency;

CREATE UNIQUE INDEX IF NOT EXISTS uq_estimates_account_idempotency
  ON estimates(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 3. Indexes -----------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_estimates_account_id ON estimates(account_id);
CREATE INDEX IF NOT EXISTS idx_estimates_project_id ON estimates(project_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_created_by ON estimates(created_by);
CREATE INDEX IF NOT EXISTS idx_estimates_deleted_at ON estimates(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate_id ON estimate_line_items(estimate_id);
CREATE INDEX IF NOT EXISTS idx_estimate_line_items_account_id ON estimate_line_items(account_id);
CREATE INDEX IF NOT EXISTS idx_estimate_line_items_position ON estimate_line_items(estimate_id, position);

-- 4. updated_at triggers ----------------------------------------

DROP TRIGGER IF EXISTS trg_estimates_updated_at ON estimates;
CREATE TRIGGER trg_estimates_updated_at
  BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_estimate_line_items_updated_at ON estimate_line_items;
CREATE TRIGGER trg_estimate_line_items_updated_at
  BEFORE UPDATE ON estimate_line_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Hard-delete prevention (financial audit integrity) ---------

CREATE OR REPLACE FUNCTION prevent_hard_delete_estimates()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Hard deletion of estimates is not allowed. Use soft-delete (deleted_at) or status transitions.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_hard_delete_estimates ON estimates;
CREATE TRIGGER trg_prevent_hard_delete_estimates
  BEFORE DELETE ON estimates
  FOR EACH ROW EXECUTE FUNCTION prevent_hard_delete_estimates();

-- 6. Row Level Security -----------------------------------------

ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS anyway; scoping this policy to service_role
-- prevents it from silently granting every other role full access.
DROP POLICY IF EXISTS "estimates_service_role_all" ON estimates;
CREATE POLICY "estimates_service_role_all" ON estimates
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "estimate_line_items_service_role_all" ON estimate_line_items;
CREATE POLICY "estimate_line_items_service_role_all" ON estimate_line_items
  TO service_role
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "estimates_tenant_select" ON estimates;
CREATE POLICY "estimates_tenant_select" ON estimates
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL AND (
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.id = auth.uid()
          AND (user_profiles.is_superadmin = TRUE OR user_profiles.client_account_id = estimates.account_id)
      )
      OR
      EXISTS (
        SELECT 1 FROM accounts
        WHERE accounts.id = estimates.account_id
          AND accounts.account_manager_id = auth.uid()
      )
      OR
      EXISTS (
        SELECT 1 FROM account_members
        WHERE account_members.account_id = estimates.account_id
          AND account_members.user_id = auth.uid()
          AND account_members.removed_at IS NULL
      )
    )
  );

DROP POLICY IF EXISTS "estimates_tenant_insert" ON estimates;
CREATE POLICY "estimates_tenant_insert" ON estimates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid() AND user_profiles.is_superadmin = TRUE
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimates.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimates.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS "estimates_tenant_update" ON estimates;
CREATE POLICY "estimates_tenant_update" ON estimates
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid() AND user_profiles.is_superadmin = TRUE
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimates.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimates.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS "estimate_line_items_tenant_select" ON estimate_line_items;
CREATE POLICY "estimate_line_items_tenant_select" ON estimate_line_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND (user_profiles.is_superadmin = TRUE OR user_profiles.client_account_id = estimate_line_items.account_id)
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimate_line_items.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimate_line_items.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS "estimate_line_items_tenant_insert" ON estimate_line_items;
CREATE POLICY "estimate_line_items_tenant_insert" ON estimate_line_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid() AND user_profiles.is_superadmin = TRUE
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimate_line_items.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimate_line_items.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS "estimate_line_items_tenant_update" ON estimate_line_items;
CREATE POLICY "estimate_line_items_tenant_update" ON estimate_line_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid() AND user_profiles.is_superadmin = TRUE
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimate_line_items.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimate_line_items.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

DROP POLICY IF EXISTS "estimate_line_items_tenant_delete" ON estimate_line_items;
CREATE POLICY "estimate_line_items_tenant_delete" ON estimate_line_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid() AND user_profiles.is_superadmin = TRUE
    )
    OR
    EXISTS (
      SELECT 1 FROM accounts
      WHERE accounts.id = estimate_line_items.account_id
        AND accounts.account_manager_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_members.account_id = estimate_line_items.account_id
        AND account_members.user_id = auth.uid()
        AND account_members.removed_at IS NULL
    )
  );

-- =============================================================
-- 7. Workflow compatibility patches
-- Legacy workflow seed/routes expect these columns on databases
-- created before they were added to schema.sql.
-- =============================================================

-- Only patch workflow tables when the base schema created them.
DO $$
BEGIN
  IF to_regclass('public.workflow_nodes') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS position_x NUMERIC NOT NULL DEFAULT 0';
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS position_y NUMERIC NOT NULL DEFAULT 0';
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS step_order INTEGER NOT NULL DEFAULT 0';
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS requires_form BOOLEAN NOT NULL DEFAULT FALSE';
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS form_template_id UUID';
    EXECUTE 'ALTER TABLE workflow_nodes ADD COLUMN IF NOT EXISTS settings JSONB';
  END IF;

  IF to_regclass('public.workflow_connections') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE workflow_connections ADD COLUMN IF NOT EXISTS label TEXT';
  END IF;
END $$;

