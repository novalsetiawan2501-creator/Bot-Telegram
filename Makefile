CC      ?= gcc
CFLAGS  ?= -Wall -Wextra -O3 -g -pthread
LDFLAGS ?= -pthread

# Cek pkg-config untuk nghttp2
NGHTTP2_CFLAGS := $(shell pkg-config --cflags libnghttp2 2>/dev/null)
NGHTTP2_LIBS   := $(shell pkg-config --libs libnghttp2 2>/dev/null)
ifeq ($(strip $(NGHTTP2_LIBS)),)
NGHTTP2_LIBS := -lnghttp2
endif

# Cek pkg-config untuk openssl
OPENSSL_CFLAGS := $(shell pkg-config --cflags openssl 2>/dev/null)
OPENSSL_LIBS   := $(shell pkg-config --libs openssl 2>/dev/null)
ifeq ($(strip $(OPENSSL_LIBS)),)
OPENSSL_LIBS := -lssl -lcrypto
endif

CFLAGS  += $(NGHTTP2_CFLAGS) $(OPENSSL_CFLAGS)
LDFLAGS += $(NGHTTP2_LIBS) $(OPENSSL_LIBS)

TARGET  := h2flood
SOURCES := main.c worker.c connection.c
OBJECTS := $(SOURCES:.c=.o)
HEADERS := http2loadtest.h

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CC) -o $@ $(OBJECTS) $(LDFLAGS)
	@echo "🔥 Build success! Run with: ./$(TARGET) -u https://target.com/ -k"

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJECTS) $(TARGET)
	@echo "💀 Cleaned!"

run: $(TARGET)
	./$(TARGET) -u https://example.com/ -k -v

debug: CFLAGS += -DDEBUG -g -O0
debug: clean all

install:
	@echo "Installing dependencies..."
	@sudo apt-get update
	@sudo apt-get install -y libnghttp2-dev libssl-dev pkg-config
	@echo "✅ Dependencies installed!"

help:
	@echo "Available commands:"
	@echo "  make          - Build the tool"
	@echo "  make clean    - Remove object files and binary"
	@echo "  make run      - Run with example target"
	@echo "  make debug    - Build with debug symbols"
	@echo "  make install  - Install required dependencies"