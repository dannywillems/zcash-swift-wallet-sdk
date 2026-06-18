# Makefile for the ZcashLightClientKit onboarding course (Docusaurus site).
# Wrap lines at 80 characters. Recipes use tab indentation.

.DEFAULT_GOAL := help

.PHONY: help
help: ## Ask for help!
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; \
		{printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install npm dependencies
	npm install

.PHONY: dev
dev: ## Run the Docusaurus dev server
	npx docusaurus start

.PHONY: build
build: ## Build the static site
	npx docusaurus build

.PHONY: preview
preview: ## Serve the built static site locally
	npx docusaurus serve

.PHONY: check-format
check-format: ## Check Markdown/config formatting
	npx prettier --check .

.PHONY: format
format: ## Format Markdown/config files
	npx prettier --write .

.PHONY: clean-doc
clean-doc: ## Remove build artefacts (keeps node_modules)
	npx docusaurus clear
	rm -rf build .docusaurus
	rm -rf ../404.html ../index.html ../sitemap.xml \
		../search-index.json ../.nojekyll ../assets ../img

.PHONY: clean
clean: clean-doc ## Remove build artefacts and node_modules
	rm -rf node_modules
