import { join } from "node:path";
import { sourceModule } from "./source-module.mjs";

const policyModule = await sourceModule(join("src", "workflow-policy.ts"));

export const policyPath = join(process.cwd(), "schemas", "workflow-policy.json");
export const loadPolicy = (path = policyPath) => policyModule.loadPolicy(path);
export const compile = (task, path = policyPath) => policyModule.compileWorkflowPlan(task, loadPolicy(path));
export const stepIds = (plan, capability) => plan.selected.find((entry) => entry.name === capability)?.steps.map((step) => step.id) || [];
