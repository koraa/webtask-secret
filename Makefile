PATH := $(PWD)/node_modules/.bin/:$(PATH)

built.js: server.js
	babel --plugins transform-es2015-modules-commonjs < server.js > built.js

.PHONY: run clean

run: built.js
	node ./built.js

clean:
	rm -fv built.js
