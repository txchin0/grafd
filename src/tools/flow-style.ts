// Command line styling by role: `grafd style <file.flow>` gives each node the shape its role is
// drawn in — a decision a diamond, a store a cylinder — in the graph's canvas layer, and draws the
// edges into an error red and dashed. Roles are named by whoever knows them, or inferred from the
// graph's structure. This is how an agent styles a graph: it names roles, never writes the layer.

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileIfPresent, UNREADABLE_FILE } from '../server/flow-files.js';
import { canvasLayerIsUnreadable, canvasLayerPathOf, emptyCanvasLayer, parseCanvasLayer, serializeCanvasLayer } from '../shared/canvas-layer.js';
import { layerReadingOf, placeMissingPositions, settleNewlyPlacedNodes } from '../shared/document-layout.js';
import { parseFlow, serializeFlow, type FlowItem, type FlowNode, type GraphItem } from '../shared/flow-format.js';
import { isNodeRole, NODE_ROLES, ROLE_MEANINGS, ROLE_SHAPES, rolesToApply, styleByRoles, type NodeRole } from '../shared/node-roles.js';

interface Options {
  file: string;
  graph: string | null;
  rolesFile: string | null;
  // Roles named one at a time on the command line, by node name.
  named: [string, string][];
  infer: boolean;
}

const ROLE_TABLE = NODE_ROLES.map((role) => `  ${role.padEnd(10)} ${ROLE_SHAPES[role].padEnd(14)} ${ROLE_MEANINGS[role]}`).join('\n');
const USAGE = `Usage: grafd style <file.flow> [options]

Styles a graph's nodes by their roles, in its canvas layer: each role draws its node in a shape,
and edges into an error are drawn red and dashed. Roles are never written to the .flow.

Options:
  --role=<node>=<role>   give one node a role (repeatable)
  --roles=<file.json>    give many: a JSON object of node names to roles
  --infer                infer start, end, decision, error and process from the graph's
                         structure for nodes not named — never replacing a shape already chosen
  --graph=<name>         style a \`graph:\` block of the file instead of its body
  --help                 show this message

Roles:
${ROLE_TABLE}`;

export async function runFlowStyle(argv: string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === 'help' || options === 'invalid') {
    console.log(USAGE);
    return options === 'help' ? 0 : 2;
  }
  const outcome = await styleFlowFile(options);
  if (typeof outcome === 'string') {
    console.error(outcome);
    return 1;
  }
  for (const line of outcome) console.log(line);
  return 0;
}

function parseOptions(argv: string[]): Options | 'help' | 'invalid' {
  const options: Partial<Options> = { graph: null, rolesFile: null, named: [], infer: false };
  for (const argument of argv) {
    const [flag, value] = splitFlag(argument);
    if (flag === '--help' || flag === '-h') return 'help';
    else if (flag === '--infer' && value === null) options.infer = true;
    else if (flag === '--graph' && value) options.graph = value;
    else if (flag === '--roles' && value) options.rolesFile = value;
    else if (flag === '--role' && value && value.lastIndexOf('=') > 0) {
      const separator = value.lastIndexOf('=');
      options.named!.push([value.slice(0, separator), value.slice(separator + 1)]);
    } else if (argument.startsWith('-') || options.file) return 'invalid';
    else options.file = argument;
  }
  const asksForSomething = options.infer || options.rolesFile !== null || options.named!.length > 0;
  return options.file && asksForSomething ? (options as Options) : 'invalid';
}

function splitFlag(argument: string): [string, string | null] {
  const separator = argument.indexOf('=');
  return separator < 0 ? [argument, null] : [argument.slice(0, separator), argument.slice(separator + 1)];
}

// The lines reporting what was styled, or a message saying why nothing was.
export async function styleFlowFile(options: Options): Promise<string[] | string> {
  const flowFile = path.resolve(options.file);
  const text = await readFile(flowFile, 'utf8').catch(() => null);
  if (text === null) return `Cannot read ${options.file}.`;
  const doc = parseFlow(text);
  const items = scopeItemsOf(doc.items, options.graph);
  if (!items) return `${options.file} has no \`graph: ${options.graph}\` block.`;

  const layerFile = canvasLayerPathOf(flowFile);
  const layerText = await readFileIfPresent(layerFile);
  if (layerText === UNREADABLE_FILE || canvasLayerIsUnreadable(layerText)) {
    return `${path.basename(layerFile)} cannot be read, so it is left as it is: fix or delete it, then style again.`;
  }
  const layer = layerText === null ? emptyCanvasLayer() : parseCanvasLayer(layerText);

  const named = await namedRoles(options, items);
  if (typeof named === 'string') return named;
  // As the editor does on opening the file, so every node has a place to be sized about.
  const unplaced = new Set(nodesIn(items).filter((node) => !node.pos));
  const placed = placeMissingPositions(doc);
  const roles = rolesToApply(doc, items, layer, named, options.infer);
  const styling = styleByRoles(doc, items, layer, roles);
  const grownNew = new Set(styling.resized.map(({ node }) => node).filter((node) => unplaced.has(node)));
  const settled = settleNewlyPlacedNodes(items, grownNew.size > 0 ? unplaced : new Set(), layerReadingOf(doc, layer));

  if (placed || styling.flowChanged || settled) await writeFile(flowFile, serializeFlow(doc));
  const layerOut = serializeCanvasLayer(layer);
  if (layerOut === null) await rm(layerFile, { force: true });
  else await writeFile(layerFile, layerOut);

  return [
    ...styling.styled.map(({ node, role, shape }) => `"${node.name}" ${role}: ${shape}`),
    ...styling.resized.map(({ node, size }) => `"${node.name}" grown to ${size.w}×${size.h} so its text fits its shape`),
    ...(styling.edgesIntoErrors > 0 ? [`${styling.edgesIntoErrors} edge(s) into an error drawn red and dashed`] : []),
  ];
}

function nodesIn(items: FlowItem[]): FlowNode[] {
  return items.flatMap((item) => (item.kind === 'node' ? [item.node] : []));
}

function scopeItemsOf(items: FlowItem[], graph: string | null): FlowItem[] | null {
  if (graph === null) return items;
  return items.find((item): item is GraphItem => item.kind === 'graph' && item.name === graph)?.items ?? null;
}

// The roles named on the command line and in a roles file, by node; a message for a node or role
// that does not exist.
async function namedRoles(options: Options, items: FlowItem[]): Promise<Map<FlowNode, NodeRole> | string> {
  const entries = [...options.named];
  if (options.rolesFile !== null) {
    const raw = await readFile(options.rolesFile, 'utf8').then((text) => JSON.parse(text) as unknown).catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${options.rolesFile} is not a JSON object of node names to roles.`;
    entries.push(...Object.entries(raw).map(([name, role]) => [name, String(role)] as [string, string]));
  }
  const nodesByName = new Map(items.flatMap((item) => (item.kind === 'node' ? [[item.node.name, item.node] as const] : [])));
  const roles = new Map<FlowNode, NodeRole>();
  for (const [name, role] of entries) {
    const node = nodesByName.get(name);
    if (!node) return `No node named "${name}" in ${options.graph === null ? options.file : `graph: ${options.graph}`}.`;
    if (!isNodeRole(role)) return `"${role}" is not a role. Roles: ${NODE_ROLES.join(', ')}.`;
    roles.set(node, role);
  }
  return roles;
}

