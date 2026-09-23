const E = process.env.EAS_MOCK_NODE_MODULES;
const { confirmAsync, promptAsync, selectAsync } = require(`${E}/eas-cli/build/prompts`);
const { chooseDevicesAsync } = require(`${E}/eas-cli/build/credentials/ios/actions/DeviceUtils`);
const ora = require(`${E}/ora`);
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const resultFile = process.env.EAS_MOCK_RESULT;
const newDevice = process.env.EAS_MOCK_NEW_DEVICE;
const failMode = ['1', '2'].includes(process.env.EAS_MOCK_FAIL);

async function step(text, done, ms = 500) {
  const spinner = ora(text).start();
  await sleep(ms);
  spinner.succeed(done);
}

(async () => {
  console.log('Resolved "preview" environment for the build.');
  console.log("You've used 42% of your included build credits this billing period.");
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
      if (process.env.EAS_MOCK_PASSWORD === '1') {
        const { password } = await promptAsync({ type: 'password', name: 'password', message: 'Password (for tester@example.com):' });
        fs.appendFileSync(resultFile, `password ${password}\n`);
      }
      if (process.env.EAS_MOCK_CODE === '1') {
        const { code } = await promptAsync({ type: 'text', name: 'code', message: 'Please enter the 6 digit code you received:' });
        fs.appendFileSync(resultFile, `code ${code}\n`);
      }
      await step('Logging in', 'Logged in Local session');
    }
    await step('Fetching Apple distribution certificates', 'Fetched Apple distribution certificates', 800);
    if (index === 0 && process.env.EAS_MOCK_CERT === '1') {
      const reuse = await confirmAsync({ message: 'Reuse this distribution certificate?\nCert ID: ABC123, Serial number: 00FF, Team ID: TEAM1', initial: true });
      fs.appendFileSync(resultFile, `reuse-cert ${reuse}\n`);
    }
    if (index === 0 && process.env.EAS_MOCK_NO_DEVICES === '1') {
      const register = await confirmAsync({ message: "You don't have any registered devices yet. Would you like to register them now?", initial: true });
      fs.appendFileSync(resultFile, `register ${register}\n`);
    }
    console.log('The provisioning profile is missing the following devices:');
    devices.slice(0, 3).forEach(d => console.log(`- ${d.identifier}`));
    if (!(await confirmAsync({ message: 'Would you like to choose the devices to provision again?' }))) continue;
    const chosen = await chooseDevicesAsync(devices, alreadyProvisioned);
    fs.appendFileSync(resultFile, `selected ${target.split(' ')[0]} ${chosen.length}/${devices.length}\n`);
    await step('Handling Apple ad hoc provisioning profiles', `Updated existing profile: *[expo] ${target.split(' ')[0]} AdHoc`, 800);
    if ((index === 0 || process.env.EAS_MOCK_FAIL === '2') && failMode) {
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
  fs.appendFileSync(resultFile, 'uploaded\n');
  console.log('See logs: https://expo.dev/accounts/example/projects/example/builds/11111111-2222-3333-4444-555555555555');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
