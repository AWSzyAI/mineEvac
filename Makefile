

all: server main setup

setup:
	npm install 

server:
	cd server && java -Xmx2G -Xms1G -jar server.jar nogui

main:
	node --require ./shim-ajv.cjs src/main.js

.PHONY: all server main