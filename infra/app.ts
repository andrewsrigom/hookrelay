import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import { HookRelayStack } from './stack.js';

const app = new App();
const stageValue = app.node.tryGetContext('stage') as unknown;

if (stageValue !== undefined && stageValue !== 'dev' && stageValue !== 'production') {
  throw new Error('CDK context "stage" must be "dev" or "production".');
}

const deploymentStage = stageValue === 'production' ? 'production' : 'dev';

new HookRelayStack(app, 'HookRelay', {
  deploymentStage,
  synthesizer: new DefaultStackSynthesizer({ qualifier: 'hrelaydev' }),
});
