/**
 * Workflow service.
 *
 * Legacy workflow routes in app/api require this module. It talks to Supabase
 * with the service-role client and keeps node layout/settings compatible with
 * both the current schema (position columns + config JSON) and older clients.
 */

const { createAdminSupabaseClient } = require('@/lib/supabase-server');
const { logger } = require('@/lib/debug-logger');

function getDb(explicitClient) {
  const client = explicitClient || createAdminSupabaseClient();
  if (!client) throw new Error('Database connection failed');
  return client;
}

function normalizeNode(node) {
  if (!node) return node;
  const config = node.config || {};
  return {
    ...node,
    position_x: node.position_x ?? config.position_x ?? 0,
    position_y: node.position_y ?? config.position_y ?? 0,
    requires_form: node.requires_form ?? config.requires_form ?? false,
    form_template_id: node.form_template_id ?? config.form_template_id ?? null,
    settings: node.settings ?? config.settings ?? null,
  };
}

async function getWorkflowTemplates() {
  const { data, error } = await getDb()
    .from('workflow_templates')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getAllWorkflowTemplates() {
  const { data, error } = await getDb()
    .from('workflow_templates')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createWorkflowTemplate(name, description, createdBy) {
  const { data, error } = await getDb()
    .from('workflow_templates')
    .insert({ name, description: description || null, created_by: createdBy || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getWorkflowTemplateById(id) {
  const db = getDb();
  const { data: template, error } = await db
    .from('workflow_templates')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!template) return null;

  const [{ data: nodes, error: nodesError }, { data: connections, error: connectionsError }] =
    await Promise.all([
      db
        .from('workflow_nodes')
        .select('*')
        .eq('workflow_template_id', id)
        .order('position_x', { ascending: true }),
      db.from('workflow_connections').select('*').eq('workflow_template_id', id),
    ]);

  if (nodesError) throw nodesError;
  if (connectionsError) throw connectionsError;

  return {
    ...template,
    nodes: (nodes || []).map(normalizeNode),
    connections: connections || [],
  };
}

async function updateWorkflowTemplate(id, updates, explicitClient) {
  const db = getDb(explicitClient);
  const payload = {};
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.is_active !== undefined) payload.is_active = updates.is_active;

  const { data, error } = await db
    .from('workflow_templates')
    .update(payload)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function deleteWorkflowTemplate(id, explicitClient) {
  const db = getDb(explicitClient);

  const { count, error: countError } = await db
    .from('workflow_instances')
    .select('id', { count: 'exact', head: true })
    .eq('workflow_template_id', id);
  if (countError) throw countError;

  if (count && count > 0) {
    throw new Error(
      'Cannot delete workflow template with existing instances. Deactivate it instead.',
    );
  }

  // workflow_nodes and workflow_connections cascade from the template.
  const { error } = await db.from('workflow_templates').delete().eq('id', id);
  if (error) throw error;
  return true;
}

async function createWorkflowNode(templateId, input) {
  const db = getDb();
  const nodeType = input.node_type === 'client' ? 'approval' : input.node_type;
  const config = {};
  if (input.requires_form !== undefined) config.requires_form = input.requires_form;
  if (input.form_template_id !== undefined) config.form_template_id = input.form_template_id;
  if (input.settings !== undefined) config.settings = input.settings;

  const { data, error } = await db
    .from('workflow_nodes')
    .insert({
      workflow_template_id: templateId,
      label: input.label,
      node_type: nodeType,
      entity_id: input.entity_id || null,
      position_x: input.position_x ?? 0,
      position_y: input.position_y ?? 0,
      requires_form: input.requires_form ?? false,
      form_template_id: input.form_template_id || null,
      settings: input.settings ?? null,
      config: Object.keys(config).length ? config : null,
    })
    .select()
    .single();
  if (error) throw error;
  return normalizeNode(data);
}

async function updateWorkflowNode(nodeId, input) {
  const db = getDb();
  const payload = {};
  if (input.label !== undefined) payload.label = input.label;
  if (input.node_type !== undefined) {
    payload.node_type = input.node_type === 'client' ? 'approval' : input.node_type;
  }
  if (input.entity_id !== undefined) payload.entity_id = input.entity_id;
  if (input.position_x !== undefined) payload.position_x = input.position_x;
  if (input.position_y !== undefined) payload.position_y = input.position_y;
  if (input.requires_form !== undefined) payload.requires_form = input.requires_form;
  if (input.form_template_id !== undefined) payload.form_template_id = input.form_template_id || null;
  if (input.settings !== undefined) payload.settings = input.settings;

  const nextConfig = {};
  if (input.requires_form !== undefined) nextConfig.requires_form = input.requires_form;
  if (input.form_template_id !== undefined) nextConfig.form_template_id = input.form_template_id;
  if (input.settings !== undefined) nextConfig.settings = input.settings;

  if (Object.keys(nextConfig).length > 0) {
    const { data: existing } = await db
      .from('workflow_nodes')
      .select('config')
      .eq('id', nodeId)
      .maybeSingle();
    payload.config = { ...((existing && existing.config) || {}), ...nextConfig };
  }

  const { data, error } = await db
    .from('workflow_nodes')
    .update(payload)
    .eq('id', nodeId)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ? normalizeNode(data) : null;
}

async function deleteWorkflowNode(nodeId) {
  const { error } = await getDb().from('workflow_nodes').delete().eq('id', nodeId);
  if (error) throw error;
  return true;
}

async function createWorkflowConnection(templateId, fromNodeId, toNodeId, condition) {
  const serializedCondition =
    condition === undefined || condition === null
      ? null
      : typeof condition === 'string'
        ? condition
        : JSON.stringify(condition);

  const { data, error } = await getDb()
    .from('workflow_connections')
    .insert({
      workflow_template_id: templateId,
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      condition: serializedCondition,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteWorkflowConnection(connectionId) {
  const { error } = await getDb().from('workflow_connections').delete().eq('id', connectionId);
  if (error) throw error;
  return true;
}

async function findNodeAssignee(db, nodeId) {
  const { data } = await db
    .from('workflow_node_assignments')
    .select('assigned_user_id')
    .eq('workflow_node_id', nodeId)
    .limit(1)
    .maybeSingle();
  return (data && data.assigned_user_id) || null;
}

async function startWorkflowInstance({
  workflowTemplateId,
  projectId = null,
  taskId = null,
  startNodeId = null,
}) {
  const db = getDb();

  const { data: template, error: templateError } = await db
    .from('workflow_templates')
    .select('*')
    .eq('id', workflowTemplateId)
    .maybeSingle();
  if (templateError) throw templateError;
  if (!template) throw new Error('Workflow template not found');
  if (!template.is_active) throw new Error('Workflow template is not active');

  const { data: nodes, error: nodesError } = await db
    .from('workflow_nodes')
    .select('*')
    .eq('workflow_template_id', workflowTemplateId)
    .order('position_x', { ascending: true });
  if (nodesError) throw nodesError;
  if (!nodes || nodes.length === 0) throw new Error('Workflow template has no nodes');

  const startNode = startNodeId
    ? nodes.find((node) => node.id === startNodeId)
    : nodes.find((node) => node.node_type === 'start') || nodes[0];
  if (!startNode) throw new Error('Invalid start node');

  const { data: connections } = await db
    .from('workflow_connections')
    .select('*')
    .eq('workflow_template_id', workflowTemplateId);

  const isComplete = startNode.node_type === 'end';

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .insert({
      workflow_template_id: workflowTemplateId,
      project_id: projectId || null,
      task_id: taskId || null,
      current_node_id: startNode.id,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? new Date().toISOString() : null,
      started_snapshot: {
        template,
        nodes: nodes.map(normalizeNode),
        connections: connections || [],
      },
    })
    .select()
    .single();
  if (instanceError) throw instanceError;

  const assignedUserId = await findNodeAssignee(db, startNode.id);
  await db.from('workflow_active_steps').insert({
    workflow_instance_id: instance.id,
    node_id: startNode.id,
    assigned_user_id: assignedUserId,
    status: isComplete ? 'completed' : 'active',
    completed_at: isComplete ? new Date().toISOString() : null,
  });

  return instance;
}

async function getWorkflowInstanceById(id) {
  const db = getDb();
  const { data: instance, error } = await db
    .from('workflow_instances')
    .select(
      '*, workflow_template:workflow_templates(*), current_node:workflow_nodes!current_node_id(*)',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!instance) return null;

  const { data: activeSteps } = await db
    .from('workflow_active_steps')
    .select('*')
    .eq('workflow_instance_id', id)
    .eq('status', 'active');

  return {
    ...instance,
    current_node: normalizeNode(instance.current_node),
    active_steps: activeSteps || [],
  };
}

async function handoffWorkflow(explicitClient, options) {
  const db = getDb(explicitClient);
  const {
    instanceId,
    toNodeId,
    handedOffBy,
    handedOffTo = null,
    formResponseId = null,
    notes = null,
    outOfOrder = false,
  } = options || {};

  const { data: instance, error: instanceError } = await db
    .from('workflow_instances')
    .select('*')
    .eq('id', instanceId)
    .maybeSingle();
  if (instanceError) throw instanceError;
  if (!instance) throw new Error('Workflow instance not found');

  const { data: targetNode, error: nodeError } = await db
    .from('workflow_nodes')
    .select('*')
    .eq('id', toNodeId)
    .eq('workflow_template_id', instance.workflow_template_id)
    .maybeSingle();
  if (nodeError) throw nodeError;
  if (!targetNode) throw new Error('Target node not found in this workflow');

  const fromNodeId = instance.current_node_id || targetNode.id;

  const { data: historyEntry, error: historyError } = await db
    .from('workflow_history')
    .insert({
      workflow_instance_id: instanceId,
      from_node_id: fromNodeId,
      to_node_id: targetNode.id,
      transitioned_by: handedOffBy || null,
      notes: notes || null,
      transition_type: outOfOrder ? 'skip' : 'normal',
      out_of_order: Boolean(outOfOrder),
      form_response_id: formResponseId || null,
    })
    .select()
    .single();
  if (historyError) throw historyError;

  if (instance.current_node_id) {
    await db
      .from('workflow_active_steps')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('workflow_instance_id', instanceId)
      .eq('node_id', instance.current_node_id)
      .eq('status', 'active');
  }

  const isComplete = targetNode.node_type === 'end';
  const assignedUserId = handedOffTo || (await findNodeAssignee(db, targetNode.id));

  await db.from('workflow_active_steps').insert({
    workflow_instance_id: instanceId,
    node_id: targetNode.id,
    assigned_user_id: assignedUserId,
    status: isComplete ? 'completed' : 'active',
    completed_at: isComplete ? new Date().toISOString() : null,
  });

  const { error: updateError } = await db
    .from('workflow_instances')
    .update({
      current_node_id: targetNode.id,
      status: isComplete ? 'completed' : 'active',
      completed_at: isComplete ? new Date().toISOString() : null,
    })
    .eq('id', instanceId);
  if (updateError) throw updateError;

  logger.info('Workflow handoff completed', {
    instanceId,
    fromNodeId,
    toNodeId: targetNode.id,
  });

  return historyEntry;
}

async function getWorkflowHistory(instanceId) {
  const { data, error } = await getDb()
    .from('workflow_history')
    .select(
      `*,
       from_node:workflow_nodes!from_node_id(id, label, node_type),
       to_node:workflow_nodes!to_node_id(id, label, node_type),
       transitioned_by_user:user_profiles!transitioned_by(id, name, email)`,
    )
    .eq('workflow_instance_id', instanceId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getNextAvailableNodes(instanceId) {
  const db = getDb();
  const { data: instance, error } = await db
    .from('workflow_instances')
    .select('id, current_node_id')
    .eq('id', instanceId)
    .maybeSingle();
  if (error) throw error;
  if (!instance || !instance.current_node_id) return [];

  const { data: connections, error: connectionsError } = await db
    .from('workflow_connections')
    .select('to_node_id')
    .eq('from_node_id', instance.current_node_id);
  if (connectionsError) throw connectionsError;

  const nodeIds = Array.from(
    new Set((connections || []).map((connection) => connection.to_node_id).filter(Boolean)),
  );
  if (nodeIds.length === 0) return [];

  const { data: nodes, error: nodesError } = await db
    .from('workflow_nodes')
    .select('*')
    .in('id', nodeIds)
    .order('position_x', { ascending: true });
  if (nodesError) throw nodesError;

  return (nodes || []).map(normalizeNode);
}

module.exports = {
  getWorkflowTemplates,
  getAllWorkflowTemplates,
  createWorkflowTemplate,
  getWorkflowTemplateById,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
  createWorkflowNode,
  updateWorkflowNode,
  deleteWorkflowNode,
  createWorkflowConnection,
  deleteWorkflowConnection,
  startWorkflowInstance,
  getWorkflowInstanceById,
  handoffWorkflow,
  getWorkflowHistory,
  getNextAvailableNodes,
};
