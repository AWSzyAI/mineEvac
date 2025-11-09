import mineflayer from 'mineflayer'
const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 25565,
  username: 'testBot',
  version: '1.20.1',
  auth: 'offline'
});
bot.on('login', () => {
  console.log('Client version field:', bot._client.version);
  console.log('Bot.version:', bot.version);
});
bot.on('error', err => console.error('Error:', err));
bot.on('spawn', () => {
  console.log('Spawned!');
  bot.quit();
});
bot.on('error', err => console.error(err));