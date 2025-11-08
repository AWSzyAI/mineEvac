

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

# Server paths for background control (PID + log)
SERVER_DIR := server
SERVER_PID := $(SERVER_DIR)/server.pid
SERVER_LOG := $(SERVER_DIR)/logs/run.out

server: check-java
	cd server && $(JAVA) -Xmx2G -Xms1G -jar server.jar nogui

main: setup check-node
# 	$(NODE) --require ./shim-ajv.cjs src/main.js
	$(NODE) src/main.js

init:
	rm -rf server/world/* server/log/*

.PHONY: all server server-bg stop status main init check-java check-node

# Start server in background with controllable stdin and PID file
server-bg: check-java
	@mkdir -p $(SERVER_DIR)/logs
	@if [ -f "$(SERVER_PID)" ] && kill -0 "$$(< $(SERVER_PID))" 2>/dev/null; then \
	  echo "Minecraft server already running (PID=$$(cat $(SERVER_PID)))"; \
	else \
	  (cd $(SERVER_DIR) && $(JAVA) -Xmx2G -Xms1G -jar server.jar nogui >> logs/run.out 2>&1 & echo $$! > server.pid); \
	  echo "Minecraft server started (PID=$$(cat $(SERVER_PID)))"; \
	fi

stop:
	@echo "===> Checking for running Minecraft server..."
	@if [ -f "$(SERVER_PID)" ]; then \
	  PID=$$(cat $(SERVER_PID)); \
	  if kill -0 $$PID 2>/dev/null; then \
	    echo "Stopping server (PID=$$PID)..."; \
	    kill $$PID; \
	    sleep 2; \
	    if kill -0 $$PID 2>/dev/null; then \
	      echo "Force killing server (PID=$$PID)..."; \
	      kill -9 $$PID; \
	    fi; \
	    echo "Server stopped."; \
	  else \
	    echo "No running server for PID $$PID"; \
	  fi; \
	  rm -f "$(SERVER_PID)"; \
	else \
	  PID=$$(ps -ef | grep '[s]erver\.jar' | awk '{print $$2}'); \
	  if [ -n "$$PID" ]; then \
	    echo "Found running server.jar (PID=$$PID), killing..."; \
	    kill $$PID || true; \
	    sleep 2; \
	    kill -9 $$PID 2>/dev/null || true; \
	    echo "Server stopped."; \
	  else \
	    echo "No running server process found."; \
	  fi; \
	fi


status:
	@if [ -f "$(SERVER_PID)" ] && kill -0 "$$(< $(SERVER_PID))" 2>/dev/null; then \
	  echo "Server running (PID=$$(cat $(SERVER_PID)))"; \
	else \
	  echo "Server not running"; \
	fi

# Run both server (background) and bot after short delay
run: setup check-node server-bg
	echo "Waiting 8s for server warm-up..."; \
	sleep 8; \
	$(NODE) src/main.js

.PHONY: run

