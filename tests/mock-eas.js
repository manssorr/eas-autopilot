const E = process.env.EAS_MOCK_NODE_MODULES;
const { confirmAsync, promptAsync, selectAsync } = require(`${E}/eas-cli/build/prompts`);
const { chooseDevicesAsync } = require(`${E}/eas-cli/build/credentials/ios/actions/DeviceUtils`);
const ora = require(`${E}/ora`);
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const resultFile = process.env.EAS_MOCK_RESULT;
const newDevice = process.env.EAS_MOCK_NEW_DEVICE;
const failMode = process.env.EAS_MOCK_FAIL === '1';

async function step(text, done, ms = 500) {
  const spinner = ora(text).start();
  await sleep(ms);
  spinner.succeed(done);
}

(async () => {
  console.log('Resolved "preview" environment for the build.');
  await step('Checking credentials', 'Using remote iOS credentials (Expo server)');

  const devices = [{ identifier: newDevice, deviceClass: 'IPHONE', createdAt: '2026-01-02T03:04:05.000Z' }];
  for (let i = 1; i < 20; i++) {
    devices.push({ identifier: `00000000-${String(i).padStart(16, '0')}`, deviceClass: 'IPHONE', name: `Tester ${i}` });
  }
  const alreadyProvisioned = devices.slice(3).map(d => d.identifier);
  const targets = ['App (com.example.app)', 'NotificationService (com.example.app.NotificationService)', 'Widget (com.example.app.Widget)'];

  for (const [index, target] of targets.entries()) {
    console.log(`\nSetting up credentials for target ${target}\n`);
    if (index === 0) {
      await confirmAsync({ message: 'Do you want to log in to your Apple account?' });
      await promptAsync({ type: 'text', name: 'appleId', message: 'Apple ID:', initial: 'tester@example.com' });
      await step('Logging in', 'Logged in Local session');
    }
    await step('Fetching Apple distribution certificates', 'Fetched Apple distribution certificates', 800);
    console.log('The provisioning profile is missing the following devices:');
    devices.slice(0, 3).forEach(d => console.log(`- ${d.identifier}`));
    if (!(await confirmAsync({ message: 'Would you like to choose the devices to provision again?' }))) continue;
    const chosen = await chooseDevicesAsync(devices, alreadyProvisioned);
    fs.appendFileSync(resultFile, `selected ${target.split(' ')[0]} ${chosen.length}/${devices.length}\n`);
    await step('Handling Apple ad hoc provisioning profiles', `Updated existing profile: *[expo] ${target.split(' ')[0]} AdHoc`, 800);
    if (index === 0 && failMode) {
      console.log('Failed to provision 2 of the selected devices:');
      console.log(`- ${newDevice} (iPhone) (created at: 2026-01-02T03:04:05.000Z)`);
      console.log(`- ${devices[1].identifier} (iPhone) (Tester 1)`);
      console.log('Most commonly devices fail to to be provisioned while they are still being processed by Apple');
      const proceed = await selectAsync('Do you want to continue without provisioning these devices?', [
        { title: 'Yes', value: true },
        { title: 'No (EAS CLI will exit)', value: false },
      ]);
      fs.appendFileSync(resultFile, `continue ${proceed}\n`);
      if (!proceed) process.exit(1);
    }
  }
  await step('Compressing project files', 'Compressed project files');
  await step('Uploading to EAS Build', 'Uploaded to EAS');
  console.log('See logs: https://expo.dev/accounts/example/projects/example/builds/11111111-2222-3333-4444-555555555555');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
