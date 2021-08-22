#!/usr/bin/env node

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const fetch = require("node-fetch");
const Git = require("nodegit");
const glob = require("glob");

const recipeDir = path.join(__dirname, '..', "recipes");
const pluginDir = path.join(__dirname, '..', "plugins", "pub");
const tiddlerDir = path.join(__dirname, '..', "tiddlers", "plugins");
const {extractTiddlersFromWikiFile,parseStringArray,stringifyList} = require("./tiddlywiki-utils");

const isJSONFile = dirent => {
	return dirent.isFile() && path.extname(dirent.name).toLowerCase() === ".json";
};

/**
 * Return all plugins to be built from the recipes/ directory.
 */
const recipes = () => {
	let entries = fs.readdirSync(recipeDir, {withFileTypes: true});
	return entries
		.filter(isJSONFile)
		.map(dirent => path.join(recipeDir, dirent.name))
		.map(p => fs.readFileSync(p))
		.map(JSON.parse);
};

const checkRecipe = (recipe) => {
	if (!recipe.repository) {
		throw new Error("Missing recipe repository");
	}

	if (!recipe.name) {
		throw new Error("Missing recipe name");
	}

	if (!recipe.pluginPaths) {
		throw new Error("Missing recipe pluginPath");
	}
};


/**
 * Clone & build `recipe`, then install it in the `pluginDir` folder.
 */
const buildRecipeFromRepo = (recipe,callback) => {
	try {
		console.log("\x1b[36m%s\x1b[0m", `Building recipe ${recipe.repository}...`);
		checkRecipe(recipe);

		clonePlugin(recipe.repository, recipe.name, (dir) => {
			recipe.pluginPaths.forEach((pluginPath) =>{
				const pluginName = pluginPath.split("/").pop();
				installPlugin(dir, pluginName, pluginPath);
				//buildPluginTiddler(path.join(dir,pluginPath),pluginName);
				buildPluginTiddler({basePath:dir,pluginPath:pluginPath,pluginName:pluginName});
			});
//			buildPluginTiddler(dir, recipe.name);
			cleanup(dir);
			console.log("  => Done!\n");
			callback();
		});
	} catch(e) {
		console.error(`Recipe ${recipe.repository} failed!`);
		console.error(e);
	}	
};

const buildRecipeFromWiki = async (recipe, callback) => {
	console.log("\x1b[36m%s\x1b[0m",`Building recipe ${recipe.file}`);
	let response, text;
	try {
		response = await fetch(recipe.file);
		text = await response.text();
		var tiddlers = extractTiddlersFromWikiFile(text);
		if(!tiddlers) {
			console.error("Failed to extract tiddlers from",text.slice(0,1000));
			callback();
		}
		let plugins = [];
		for(const tiddler of tiddlers) {
			if(recipe.plugins.includes(tiddler.title)) {
				plugins.push(tiddler);
			}
		}
		for(const plugin of plugins) {
			var tiddlers;
			try {
				tiddlers = JSON.parse(plugin.text).tiddlers;
			} catch(e) {
				console.error(`No tiddlers in plugin ${plugin}`);
				throw new Error(`No tiddlers in plugin`);
			}
			installPluginFromJSON(plugin,tiddlers);
			//make plugin description tiddler
			buildPluginTiddler(null,plugin,tiddlers[`${plugin.title}/readme`]||tiddlers[`${plugin.title}/README`]);
		}
		console.log(`  => ${plugins.length} plugins installed`);
		console.log("  => Done!\n");
		callback();
	} catch(e) {
		console.error(`Recipe ${recipe.file} failed!`);
		console.error(e);
	}
};

const buildRecipe = async (recipe, callback) => {
	if(recipe.file) {
		buildRecipeFromWiki(recipe,callback);
	} else {	
		buildRecipeFromRepo(recipe,callback);
	}
};

/**
 * Build all recipes sequentially.
 */
const buildRecipes = (recipes) => {
	if (recipes.length) {
		buildRecipe(
			recipes[0],
			() => buildRecipes(recipes.slice(1))
		);
	}
};

/**
 * Clone a git the repository of a plugin and checkout its latest tag.
 */
const clonePlugin = (repository, name, callback) => {
	let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `npl-${name}-`));
	Git.Clone(repository, tmpDir).then(repo => {
		getLatestTag(repo, (tag) => {
			Git.Checkout.head(repo, tag).then(() => {
				console.log(`  => Checked out tag ${tag} in ${tmpDir}`);
				callback(tmpDir);
			});
		});
	});
};

const getLatestTag = (repo, callback) => {
	Git.Tag.list(repo).then((array) => {
		if (!array.length) {
			throw new Error("No tag found in repository");
		}
		let tag = array[array.length - 1];
		console.log(`  => Latest tag in repository: ${tag}`);
		callback(tag);
	});
};

const installPluginFromJSON = (plugin,tiddlers) => {
	let pluginInfo = {};
	for(const field in plugin) {
		if(!["text","revision","bag"].includes(field)) {
			pluginInfo[field] = plugin[field];
		}
	}
	if(!pluginInfo.name) {
		console.error("No name in pluginInfo");
		throw new Error("pluginInfo missing name");
	}
	const dest = path.join(pluginDir, pluginInfo.name);
	fs.mkdirSync(dest,{ recursive: true });
	fs.writeFileSync(path.join(pluginDir,pluginInfo.name,"plugin.info"),JSON.stringify(pluginInfo));
	for(const tiddler in tiddlers) {
		fs.writeFileSync(path.join(pluginDir,pluginInfo.name,`${encodeURIComponent(tiddler)}.json`),JSON.stringify(tiddlers[tiddler]));
	}
	console.log(`  => Installed plugin in ${dest}`);
};

const installPlugin = (dir, name, pluginPath) => {
	let src = path.join(dir, pluginPath);
	let dest = path.join(pluginDir, name);
	fs.copySync(src, dest);
	console.log(`  => Installed plugin in ${dest}`);
};

const buildPluginTiddler = (pathInfo, plugin, readme) => {
	if(!plugin) {
		const baseDir = pathInfo.basePath,
			name = pathInfo.pluginName,
			pluginPath = pathInfo.pluginPath;
		const pluginDir = path.join(baseDir,pluginPath);
		let readmeFile;
		let readmes = glob.sync(`readme.tid`,{matchBase:true,cwd:pluginDir,nocase:true});
		//console.log(readmes);
		if(readmes.length) {
			readmeFile = path.join(pluginDir,readmes[0]);
		} else {
			readmes = glob.sync("readme.*",{matchBase:true,cwd:baseDir,nocase:true});
			if(readmes.length) {
				readmeFile = path.join(baseDir,readmes[0]);
			}
		}
		if(!readmeFile) {
			console.warn("  x No README file found in the repository!");
			return;
		}
		console.log(`  => Building plugin tiddler from README file ${readmeFile}`);
		let contents = fs.readFileSync(readmeFile);
		let ext = path.extname(readmeFile);
		let type = ext === ".md" ? "text/x-markdown" : "text/vnd.tiddlywiki";
		fs.writeFileSync(
			path.join(tiddlerDir,`${name}.tid`),
			buildTiddlerReadme(name,contents,type)
		)
		return;
	} else {
		const text = buildTiddlerReadme(plugin.name,readme? readme.text:"","text/vnd.tiddlywiki");
		fs.writeFileSync(path.join(tiddlerDir,`${plugin.name}.tid`),text);
	}
};

const buildTiddlerReadme = (name, contents, type) => {
	return `title: ${name} plugin
tags: sqpl-plugin
type: ${type||"text/x-markdown"}

${contents}
`;
};

const findReadme = (dir) => {
	let filenames = ["readme.md", "readme.txt", "readme"];
	let entries = fs.readdirSync(dir, {withFileTypes: true});
	return entries.find(entry => filenames.includes(entry.name.toLowerCase()));
};

/**
 * Recursive delete of `dir`.
 */
const cleanup = (dir) => {
	try {
		fs.rmdirSync(dir, { recursive: true });
		console.log("  => Removed temporary clone directory");
	} catch (e) {
		console.error(`Error while deleting ${dir}.`);
	}
};

/**
 * Preliminary setup before installing plugins.
 */
const setup = () => {
	let plugins = fs.readdirSync(pluginDir, {withFileTypes: true});
	plugins.forEach(dirent => {
		if(dirent.isDirectory()) {
			fs.rmdirSync(
				path.join(pluginDir, dirent.name),
				{ recursive: true }
			);
		}
	});

	try {
		fs.rmdirSync(tiddlerDir, { recursive: true });
	}catch(e) {
		
	}
	fs.mkdirSync(tiddlerDir);
};

const build = () => {
	setup();
	buildRecipes(recipes());
};

build();
