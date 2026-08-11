CC      ?= gcc
CFLAGS  ?= -Wall -Wextra -O2 -g -pthread
LDFLAGS ?= -pthread

NGHTTP2_CFLAGS := $(shell pkg-config --cflags libnghttp2 2>/dev/null)
NGHTTP2_LIBS   := $(shell pkg-config --libs libnghttp2 2>/dev/null)
ifeq ($(strip $(NGHTTP2_LIBS)),)
NGHTTP2_LIBS := -lnghttp2
endif

OPENSSL_CFLAGS := $(shell pkg-config --cflags openssl 2>/dev/null)
OPENSSL_LIBS   := $(shell pkg-config --libs openssl 2>/dev/null)
ifeq ($(strip $(OPENSSL_LIBS)),)
OPENSSL_LIBS := -lssl -lcrypto
endif

CFLAGS  += $(NGHTTP2_CFLAGS) $(OPENSSL_CFLAGS)
LDFLAGS += $(NGHTTP2_LIBS) $(OPENSSL_LIBS)

TARGET  := h2loadtest
SOURCES := main.c worker.c connection.c
OBJECTS := $(SOURCES:.c=.o)
HEADERS := http2loadtest.h

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CC) -o $@ $(OBJECTS) $(LDFLAGS)

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJECTS) $(TARGET)
