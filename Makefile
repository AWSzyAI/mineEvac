

all: server main setup

setup:
	npm install 

# Node runtime check (require Node >= 18)
NODE ?= node
NODE_MIN_MAJOR := 18

check-node:
	@v=$$($(NODE) -p "process.versions.node" 2>/dev/null || echo 0); \
	maj=$${v%%.*}; \
	if [ "$$maj" -lt "$(NODE_MIN_MAJOR)" ]; then \
	  echo "Error: Node $(NODE_MIN_MAJOR)+ is required (current $$v)."; exit 1; \
	else echo "Node OK: $$v"; fi

# Prefer Java 17 on macOS if available; fall back to PATH 'java'
JAVA_HOME_17 := $(shell /usr/libexec/java_home -v 17 2>/dev/null)
JAVA ?= $(if $(JAVA_HOME_17),$(JAVA_HOME_17)/bin/java,java)

check-java:
	@$(JAVA) -version 2>&1 | head -n 1 | grep -E '"1[7-9]|2[0-9]' >/dev/null \
		&& echo "Java OK: $$($(JAVA) -version 2>&1 | head -n 1)" \
		|| (echo "Error: Java 17+ is required. Current: $$($(JAVA) -version 2>&1 | head -n 1)" && \
			echo "Tip: On macOS install Temurin 17 or OpenJDK 17, or ensure /usr/libexec/java_home -v 17 exists." && exit 1)

server: check-java
	cd server && $(JAVA) -Xmx2G -Xms1G -jar server.jar nogui

main: setup check-node
# 	$(NODE) --require ./shim-ajv.cjs src/main.js
	$(NODE) src/main.js

init:
	rm -rf server/world/* server/log/*

.PHONY: all server main init check-java check-node

# Run both server (background) and bot after short delay
run: check-java setup check-node
	cd server && $(JAVA) -Xmx2G -Xms1G -jar server.jar nogui & \
	SVPID=$$!; echo "Minecraft server started (PID=$$SVPID). Waiting 8s..."; \
	sleep 8; \
	$(NODE) src/main.js

.PHONY: run

