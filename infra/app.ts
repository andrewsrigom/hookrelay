import { App } from 'aws-cdk-lib';
import { HookRelayStack } from './stack.js';

const app = new App();

new HookRelayStack(app, 'HookRelay');
