#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
PACKAGE_PATH=${PACKAGE_PATH:-"package.json"}
TAG_PREFIX=${TAG_PREFIX:-"v"}
SKIP_FILES_CHECK=${SKIP_FILES_CHECK:-"false"}

echo -e "${BLUE}🔍 npm Version Check Action${NC}"
echo "Package path: $PACKAGE_PATH"
echo "Tag prefix: $TAG_PREFIX"
echo "Skip files check: $SKIP_FILES_CHECK"

# Check if package.json exists
if [[ ! -f "$PACKAGE_PATH" ]]; then
    echo -e "${RED}❌ ERROR: package.json not found at path: $PACKAGE_PATH${NC}"
    exit 1
fi

# Initialize outputs
echo "version-changed=false" >> $GITHUB_OUTPUT
echo "current-version=" >> $GITHUB_OUTPUT
echo "previous-version=" >> $GITHUB_OUTPUT

# Check if we should run the version check based on file changes
if [[ "$SKIP_FILES_CHECK" != "true" && "$GITHUB_EVENT_NAME" == "pull_request" ]]; then
    echo -e "${BLUE}📁 Checking files changed in PR...${NC}"
    
    # Get the files changed in the PR
    CHANGED_FILES=$(git diff --name-only $PR_BASE_SHA $CURRENT_SHA)
    echo "Files changed: $CHANGED_FILES"
    
    # Check if any JS or package files were changed
    JS_CHANGED=$(echo "$CHANGED_FILES" | grep -E '\.(js|ts|jsx|tsx|json)$' | grep -E '(\.js$|\.ts$|\.jsx$|\.tsx$|package.*\.json$)' || true)
    
    if [[ -z "$JS_CHANGED" ]]; then
        echo -e "${YELLOW}⏭️  No JavaScript/TypeScript or package files changed, skipping version check${NC}"
        exit 0
    fi
    
    echo -e "${GREEN}✅ JavaScript/TypeScript or package files changed, proceeding with version check...${NC}"
    echo "Changed files: $JS_CHANGED"
fi

# Get the current version from package.json
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' "$PACKAGE_PATH" | cut -d'"' -f4)

if [[ -z "$CURRENT_VERSION" ]]; then
    echo -e "${RED}❌ ERROR: Could not extract version from $PACKAGE_PATH${NC}"
    exit 1
fi

echo -e "${BLUE}📦 Current version: $CURRENT_VERSION${NC}"
echo "current-version=$CURRENT_VERSION" >> $GITHUB_OUTPUT

# Get the latest tag
echo -e "${BLUE}🏷️  Fetching git tags...${NC}"
git fetch --tags

# Find the latest version tag with the specified prefix
LATEST_TAG=$(git tag -l | sort -V | grep -E "^${TAG_PREFIX}[0-9]+\.[0-9]+\.[0-9]+" | tail -n 1)

if [[ -z "$LATEST_TAG" ]]; then
    echo -e "${YELLOW}🎉 No previous version tag found, this appears to be the first release.${NC}"
    echo -e "${GREEN}✅ Version check passed - first release${NC}"
    echo "version-changed=true" >> $GITHUB_OUTPUT
    exit 0
fi

# Extract version from the latest tag
LATEST_VERSION=${LATEST_TAG#$TAG_PREFIX}
echo -e "${BLUE}🔖 Latest released version: $LATEST_VERSION (tag: $LATEST_TAG)${NC}"
echo "previous-version=$LATEST_VERSION" >> $GITHUB_OUTPUT

# Compare versions using semantic version comparison
echo -e "${BLUE}⚖️  Comparing versions...${NC}"

if [[ "$LATEST_VERSION" == "$CURRENT_VERSION" ]]; then
    echo -e "${RED}❌ ERROR: Package version ($CURRENT_VERSION) is the same as the latest release. You need to increment it.${NC}"
    echo -e "${YELLOW}💡 HINT: Run 'npm version patch', 'npm version minor', or 'npm version major' to increment the version${NC}"
    exit 1
elif [[ "$(printf '%s\n' "$LATEST_VERSION" "$CURRENT_VERSION" | sort -V | head -n1)" == "$CURRENT_VERSION" ]]; then
    echo -e "${RED}❌ ERROR: Package version ($CURRENT_VERSION) is lower than the latest release ($LATEST_VERSION)${NC}"
    echo -e "${YELLOW}💡 HINT: Version should be higher than the previous release. Consider using semantic versioning.${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Version has been properly incremented from $LATEST_VERSION to $CURRENT_VERSION${NC}"
    echo -e "${GREEN}🎯 Semantic versioning check passed!${NC}"
    echo "version-changed=true" >> $GITHUB_OUTPUT
fi

echo -e "${GREEN}🏁 Version check completed successfully${NC}"