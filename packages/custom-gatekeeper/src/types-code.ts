const TYPES_CODE = `/** Information supplied by the organization operating this CloudflareOS deployment. */
export interface CustomDeploymentInfo {
  name: string;
  message: string;
}

/** Example read-only capability provided to the CloudflareOS agent. */
export interface CustomSession {
  /** Returns the deployment's example information after recording an observation. */
  getDeploymentInfo(): Promise<CustomDeploymentInfo>;
}
export interface ProjectStatus { id: string; alias: string; models: string[]; deviceStatus: 'online' | 'offline' | 'revoked'; lastSeen: number; }
export interface TaskStatus {
  id: string; projectId: string; model: string;
  status: 'pending' | 'queued' | 'running' | 'cancel-requested' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  progress?: string; result?: string;
}
/** Owner-only capability for one paired, locally configured project. Pi is not a filesystem sandbox. */
export interface PiProject {
  getStatus(): Promise<ProjectStatus>;
  /** Starts an independent Pi session. Model must appear in the project's models list. */
  submitTask(input: { prompt: string; model?: string }): Promise<PiTask>;
  getTask(id: string): Promise<PiTask>;
}
export interface PiTask {
  /** Uncertain tasks must be investigated locally; never blindly resubmit side effects. */
  getStatus(): Promise<TaskStatus>;
  /** Requests stop. Wait for a terminal status; already performed changes are not undone. */
  cancel(): Promise<void>;
}
`;

export default TYPES_CODE;
