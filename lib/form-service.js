/**
 * Form service — workflow form templates and responses.
 */

const { createAdminSupabaseClient } = require('@/lib/supabase-server');

function getDb(explicitClient) {
  const client = explicitClient || createAdminSupabaseClient();
  if (!client) throw new Error('Database connection failed');
  return client;
}

async function submitFormResponse({
  formTemplateId,
  responseData,
  submittedBy,
  workflowHistoryId = null,
}) {
  const db = getDb();

  const { data, error } = await db
    .from('form_responses')
    .insert({
      form_template_id: formTemplateId,
      response_data: responseData || {},
      submitted_by: submittedBy,
      workflow_history_id: workflowHistoryId || null,
    })
    .select()
    .single();
  if (error) throw error;

  // Link the response back to the workflow history entry when provided.
  if (workflowHistoryId) {
    await db
      .from('workflow_history')
      .update({ form_response_id: data.id })
      .eq('id', workflowHistoryId);
  }

  return data;
}

async function getFormResponseById(id) {
  const { data, error } = await getDb()
    .from('form_responses')
    .select(
      `*,
       form_template:form_templates(*),
       submitted_by_user:user_profiles!submitted_by(id, name, email)`,
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getFormResponseByHistoryId(workflowHistoryId) {
  const { data, error } = await getDb()
    .from('form_responses')
    .select(
      `*,
       form_template:form_templates(*),
       submitted_by_user:user_profiles!submitted_by(id, name, email)`,
    )
    .eq('workflow_history_id', workflowHistoryId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

module.exports = {
  submitFormResponse,
  getFormResponseById,
  getFormResponseByHistoryId,
};
