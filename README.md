
启动mc服务器
```bash
git clone xxx
cd mineEvac
cd server
java -Xmx2G -Xms1G -jar server.jar nogui
ps aux | grep server.jar

```

```bash
tp szy 50 5 20
scoreboard players set szy joined 0
```


```
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node baseline.js
FLAT=1 node src/main.js
```


1. clean: 破坏地面以上的所有方块，初始化整个平坦、恒日、无重力、安全、无生物的地图
2. build: 根据layout文件生成带有房间、门、exits、hallway的building地图
3. occupants: 在不同房间中随机添加{occupants.num}个occupants,{occupants.num}位于config.json中