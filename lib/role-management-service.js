/**
 * Role management service — used by the role admin API.
 */

const { createAdminSupabaseClient } = require('@/lib/supabase-server');

function getDb(explicitClient) {
  const client = explicitClient || createAdminSupabaseClient();
  if (!client) throw new Error('Database connection failed');
  return client;
}

function buildUpdatePayload(input) {
  const payload = {};
  if (input.name !== undefined) payload.name = String(input.name).trim();
  if (input.description !== undefined) payload.description = input.description;
  if (input.department_id !== undefined) payload.department_id = input.department_id || null;
  if (input.hierarchy_level !== undefined) payload.hierarchy_level = input.hierarchy_level;
  if (input.reporting_role_id !== undefined) {
    payload.reporting_role_id = input.reporting_role_id || null;
  }
  if (input.permissions !== undefined) payload.permissions = input.permissions;
  return payload;
}

const roleManagementService = {
  async getRole(roleId, explicitClient) {
    const { data, error } = await getDb(explicitClient)
      .from('roles')
      .select('*')
      .eq('id', roleId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },

  async listRoles(explicitClient) {
    const { data, error } = await getDb(explicitClient)
      .from('roles')
      .select('*')
      .order('hierarchy_level', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async updateRole(roleId, input, explicitClient) {
    const db = getDb(explicitClient);
    const payload = buildUpdatePayload(input || {});

    if (Object.keys(payload).length === 0) {
      const { data, error } = await db
        .from('roles')
        .select('*')
        .eq('id', roleId)
        .maybeSingle();
      if (error) throw error;
      return data || null;
    }

    const { data, error } = await db
      .from('roles')
      .update(payload)
      .eq('id', roleId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },
};

module.exports = { roleManagementService };
