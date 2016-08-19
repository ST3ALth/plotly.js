/**
* Copyright 2012-2016, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/


'use strict';

var d3 = require('d3');
var isNumeric = require('fast-isnumeric');

var Plotly = require('../plotly');
var Lib = require('../lib');
var Events = require('../lib/events');
var Queue = require('../lib/queue');

var Registry = require('../registry');
var Plots = require('../plots/plots');
var Fx = require('../plots/cartesian/graph_interact');
var Polar = require('../plots/polar');

var Color = require('../components/color');
var Drawing = require('../components/drawing');
var ErrorBars = require('../components/errorbars');
var Titles = require('../components/titles');
var ModeBar = require('../components/modebar');
var xmlnsNamespaces = require('../constants/xmlns_namespaces');
var svgTextUtils = require('../lib/svg_text_utils');

var helpers = require('./helpers');


/**
 * Main plot-creation function
 *
 * Note: will call makePlotFramework if necessary to create the framework
 *
 * @param {string id or DOM element} gd
 *      the id or DOM element of the graph container div
 * @param {array of objects} data
 *      array of traces, containing the data and display information for each trace
 * @param {object} layout
 *      object describing the overall display of the plot,
 *      all the stuff that doesn't pertain to any individual trace
 * @param {object} config
 *      configuration options (see ./plot_config.js for more info)
 *
 */
Plotly.plot = function(gd, data, layout, config) {
    gd = helpers.getGraphDiv(gd);

    // Events.init is idempotent and bails early if gd has already been init'd
    Events.init(gd);

    var okToPlot = Events.triggerHandler(gd, 'plotly_beforeplot', [data, layout, config]);
    if(okToPlot === false) return Promise.reject();

    // if there's no data or layout, and this isn't yet a plotly plot
    // container, log a warning to help plotly.js users debug
    if(!data && !layout && !Lib.isPlotDiv(gd)) {
        Lib.warn('Calling Plotly.plot as if redrawing ' +
            'but this container doesn\'t yet have a plot.', gd);
    }

    // transfer configuration options to gd until we move over to
    // a more OO like model
    setPlotContext(gd, config);

    if(!layout) layout = {};

    // hook class for plots main container (in case of plotly.js
    // this won't be #embedded-graph or .js-tab-contents)
    d3.select(gd).classed('js-plotly-plot', true);

    // off-screen getBoundingClientRect testing space,
    // in #js-plotly-tester (and stored as gd._tester)
    // so we can share cached text across tabs
    Drawing.makeTester(gd);

    // collect promises for any async actions during plotting
    // any part of the plotting code can push to gd._promises, then
    // before we move to the next step, we check that they're all
    // complete, and empty out the promise list again.
    gd._promises = [];

    var graphWasEmpty = ((gd.data || []).length === 0 && Array.isArray(data));

    // if there is already data on the graph, append the new data
    // if you only want to redraw, pass a non-array for data
    if(Array.isArray(data)) {
        helpers.cleanData(data, gd.data);

        if(graphWasEmpty) gd.data = data;
        else gd.data.push.apply(gd.data, data);

        // for routines outside graph_obj that want a clean tab
        // (rather than appending to an existing one) gd.empty
        // is used to determine whether to make a new tab
        gd.empty = false;
    }

    if(!gd.layout || graphWasEmpty) gd.layout = helpers.cleanLayout(layout);

    // if the user is trying to drag the axes, allow new data and layout
    // to come in but don't allow a replot.
    if(gd._dragging) {
        // signal to drag handler that after everything else is done
        // we need to replot, because something has changed
        gd._replotPending = true;
        return Promise.reject();
    } else {
        // we're going ahead with a replot now
        gd._replotPending = false;
    }

    Plots.supplyDefaults(gd);

    // Polar plots
    if(data && data[0] && data[0].r) return plotPolar(gd, data, layout);

    // so we don't try to re-call Plotly.plot from inside
    // legend and colorbar, if margins changed
    gd._replotting = true;
    var hasData = gd._fullData.length > 0;

    var subplots = Plotly.Axes.getSubplots(gd).join(''),
        oldSubplots = Object.keys(gd._fullLayout._plots || {}).join(''),
        hasSameSubplots = (oldSubplots === subplots);

    // Make or remake the framework (ie container and axes) if we need to
    // note: if they container already exists and has data,
    //  the new layout gets ignored (as it should)
    //  but if there's no data there yet, it's just a placeholder...
    //  then it should destroy and remake the plot
    if(hasData) {
        if(gd.framework !== makePlotFramework || graphWasEmpty || !hasSameSubplots) {
            gd.framework = makePlotFramework;
            makePlotFramework(gd);
        }
    }
    else if(!hasSameSubplots) {
        gd.framework = makePlotFramework;
        makePlotFramework(gd);
    }
    else if(graphWasEmpty) makePlotFramework(gd);

    // save initial axis range once per graph
    if(graphWasEmpty) Plotly.Axes.saveRangeInitial(gd);

    var fullLayout = gd._fullLayout;

    // prepare the data and find the autorange

    // generate calcdata, if we need to
    // to force redoing calcdata, just delete it before calling Plotly.plot
    var recalc = !gd.calcdata || gd.calcdata.length !== (gd.data || []).length;
    if(recalc) doCalcdata(gd);

    // in case it has changed, attach fullData traces to calcdata
    for(var i = 0; i < gd.calcdata.length; i++) {
        gd.calcdata[i][0].trace = gd._fullData[i];
    }

    /*
     * start async-friendly code - now we're actually drawing things
     */

    var oldmargins = JSON.stringify(fullLayout._size);

    // draw anything that can affect margins.
    // currently this is legend and colorbars
    function marginPushers() {
        var calcdata = gd.calcdata;
        var i, cd, trace;

        Registry.getComponentMethod('legend', 'draw')(gd);
        Registry.getComponentMethod('rangeselector', 'draw')(gd);
        Registry.getComponentMethod('updatemenus', 'draw')(gd);

        for(i = 0; i < calcdata.length; i++) {
            cd = calcdata[i];
            trace = cd[0].trace;
            if(trace.visible !== true || !trace._module.colorbar) {
                Plots.autoMargin(gd, 'cb' + trace.uid);
            }
            else trace._module.colorbar(gd, cd);
        }

        Plots.doAutoMargin(gd);
        return Plots.previousPromises(gd);
    }

    function marginPushersAgain() {
        // in case the margins changed, draw margin pushers again
        var seq = JSON.stringify(fullLayout._size) === oldmargins ?
            [] : [marginPushers, layoutStyles];
        return Lib.syncOrAsync(seq.concat(Fx.init), gd);
    }

    function positionAndAutorange() {
        if(!recalc) return;

        var subplots = Plots.getSubplotIds(fullLayout, 'cartesian'),
            modules = fullLayout._modules;

        // position and range calculations for traces that
        // depend on each other ie bars (stacked or grouped)
        // and boxes (grouped) push each other out of the way

        var subplotInfo, _module;

        for(var i = 0; i < subplots.length; i++) {
            subplotInfo = fullLayout._plots[subplots[i]];

            for(var j = 0; j < modules.length; j++) {
                _module = modules[j];
                if(_module.setPositions) _module.setPositions(gd, subplotInfo);
            }
        }


        // calc and autorange for errorbars
        ErrorBars.calc(gd);

        // TODO: autosize extra for text markers
        return Lib.syncOrAsync([
            Registry.getComponentMethod('shapes', 'calcAutorange'),
            Registry.getComponentMethod('annotations', 'calcAutorange'),
            doAutoRange
        ], gd);
    }

    function doAutoRange() {
        var axList = Plotly.Axes.list(gd, '', true);
        for(var i = 0; i < axList.length; i++) {
            Plotly.Axes.doAutoRange(axList[i]);
        }
    }

    function drawAxes() {
        // draw ticks, titles, and calculate axis scaling (._b, ._m)
        return Plotly.Axes.doTicks(gd, 'redraw');
    }

    // Now plot the data
    function drawData() {
        var calcdata = gd.calcdata,
            i;

        // in case of traces that were heatmaps or contour maps
        // previously, remove them and their colorbars explicitly
        for(i = 0; i < calcdata.length; i++) {
            var trace = calcdata[i][0].trace,
                isVisible = (trace.visible === true),
                uid = trace.uid;

            if(!isVisible || !Registry.traceIs(trace, '2dMap')) {
                fullLayout._paper.selectAll(
                    '.hm' + uid +
                    ',.contour' + uid +
                    ',#clip' + uid
                ).remove();
            }

            if(!isVisible || !trace._module.colorbar) {
                fullLayout._infolayer.selectAll('.cb' + uid).remove();
            }
        }

        // loop over the base plot modules present on graph
        var basePlotModules = fullLayout._basePlotModules;
        for(i = 0; i < basePlotModules.length; i++) {
            basePlotModules[i].plot(gd);
        }

        // styling separate from drawing
        Plots.style(gd);

        // show annotations and shapes
        Registry.getComponentMethod('shapes', 'draw')(gd);
        Registry.getComponentMethod('annoations', 'draw')(gd);

        // source links
        Plots.addLinks(gd);

        // Mark the first render as complete
        gd._replotting = false;

        return Plots.previousPromises(gd);
    }

    // An initial paint must be completed before these components can be
    // correctly sized and the whole plot re-margined. gd._replotting must
    // be set to false before these will work properly.
    function finalDraw() {
        Registry.getComponentMethod('shapes', 'draw')(gd);
        Registry.getComponentMethod('images', 'draw')(gd);
        Registry.getComponentMethod('annotations', 'draw')(gd);
        Registry.getComponentMethod('legend', 'draw')(gd);
        Registry.getComponentMethod('rangeslider', 'draw')(gd);
        Registry.getComponentMethod('rangeselector', 'draw')(gd);
        Registry.getComponentMethod('updatemenus', 'draw')(gd);
    }

    function cleanUp() {
        // now we're REALLY TRULY done plotting...
        // so mark it as done and let other procedures call a replot
        gd.emit('plotly_afterplot');
    }

    Lib.syncOrAsync([
        Plots.previousPromises,
        marginPushers,
        marginPushersAgain,
        positionAndAutorange,
        layoutStyles,
        drawAxes,
        drawData,
        finalDraw
    ], gd, cleanUp);

    // even if everything we did was synchronous, return a promise
    // so that the caller doesn't care which route we took
    return Promise.all(gd._promises).then(function() {
        return gd;
    });
};


function opaqueSetBackground(gd, bgColor) {
    gd._fullLayout._paperdiv.style('background', 'white');
    Plotly.defaultConfig.setBackground(gd, bgColor);
}

function setPlotContext(gd, config) {
    if(!gd._context) gd._context = Lib.extendFlat({}, Plotly.defaultConfig);
    var context = gd._context;

    if(config) {
        Object.keys(config).forEach(function(key) {
            if(key in context) {
                if(key === 'setBackground' && config[key] === 'opaque') {
                    context[key] = opaqueSetBackground;
                }
                else context[key] = config[key];
            }
        });

        // map plot3dPixelRatio to plotGlPixelRatio for backward compatibility
        if(config.plot3dPixelRatio && !context.plotGlPixelRatio) {
            context.plotGlPixelRatio = context.plot3dPixelRatio;
        }
    }

    //staticPlot forces a bunch of others:
    if(context.staticPlot) {
        context.editable = false;
        context.autosizable = false;
        context.scrollZoom = false;
        context.doubleClick = false;
        context.showTips = false;
        context.showLink = false;
        context.displayModeBar = false;
    }
}

function plotPolar(gd, data, layout) {
    // build or reuse the container skeleton
    var plotContainer = d3.select(gd).selectAll('.plot-container')
        .data([0]);
    plotContainer.enter()
        .insert('div', ':first-child')
        .classed('plot-container plotly', true);
    var paperDiv = plotContainer.selectAll('.svg-container')
        .data([0]);
    paperDiv.enter().append('div')
        .classed('svg-container', true)
        .style('position', 'relative');

    // empty it everytime for now
    paperDiv.html('');

    // fulfill gd requirements
    if(data) gd.data = data;
    if(layout) gd.layout = layout;
    Polar.manager.fillLayout(gd);

    if(gd._fullLayout.autosize === 'initial' && gd._context.autosizable) {
        plotAutoSize(gd, {});
        gd._fullLayout.autosize = layout.autosize = true;
    }
    // resize canvas
    paperDiv.style({
        width: gd._fullLayout.width + 'px',
        height: gd._fullLayout.height + 'px'
    });

    // instantiate framework
    gd.framework = Polar.manager.framework(gd);

    // plot
    gd.framework({data: gd.data, layout: gd.layout}, paperDiv.node());

    // set undo point
    gd.framework.setUndoPoint();

    // get the resulting svg for extending it
    var polarPlotSVG = gd.framework.svg();

    // editable title
    var opacity = 1;
    var txt = gd._fullLayout.title;
    if(txt === '' || !txt) opacity = 0;
    var placeholderText = 'Click to enter title';

    var titleLayout = function() {
        this.call(svgTextUtils.convertToTspans);
        //TODO: html/mathjax
        //TODO: center title
    };

    var title = polarPlotSVG.select('.title-group text')
        .call(titleLayout);

    if(gd._context.editable) {
        title.attr({'data-unformatted': txt});
        if(!txt || txt === placeholderText) {
            opacity = 0.2;
            title.attr({'data-unformatted': placeholderText})
                .text(placeholderText)
                .style({opacity: opacity})
                .on('mouseover.opacity', function() {
                    d3.select(this).transition().duration(100)
                        .style('opacity', 1);
                })
                .on('mouseout.opacity', function() {
                    d3.select(this).transition().duration(1000)
                        .style('opacity', 0);
                });
        }

        var setContenteditable = function() {
            this.call(svgTextUtils.makeEditable)
                .on('edit', function(text) {
                    gd.framework({layout: {title: text}});
                    this.attr({'data-unformatted': text})
                        .text(text)
                        .call(titleLayout);
                    this.call(setContenteditable);
                })
                .on('cancel', function() {
                    var txt = this.attr('data-unformatted');
                    this.text(txt).call(titleLayout);
                });
        };
        title.call(setContenteditable);
    }

    gd._context.setBackground(gd, gd._fullLayout.paper_bgcolor);
    Plots.addLinks(gd);

    return Promise.resolve();
}

// convenience function to force a full redraw, mostly for use by plotly.js
Plotly.redraw = function(gd) {
    gd = helpers.getGraphDiv(gd);

    if(!Lib.isPlotDiv(gd)) {
        Lib.warn('This element is not a Plotly plot.', gd);
        return;
    }

    gd.calcdata = undefined;
    return Plotly.plot(gd).then(function() {
        gd.emit('plotly_redraw');
        return gd;
    });
};

/**
 * Convenience function to make idempotent plot option obvious to users.
 *
 * @param gd
 * @param {Object[]} data
 * @param {Object} layout
 * @param {Object} config
 */
Plotly.newPlot = function(gd, data, layout, config) {
    gd = helpers.getGraphDiv(gd);

    // remove gl contexts
    Plots.cleanPlot([], {}, gd._fullData || {}, gd._fullLayout || {});

    Plots.purge(gd);
    return Plotly.plot(gd, data, layout, config);
};

function doCalcdata(gd) {
    var axList = Plotly.Axes.list(gd),
        fullData = gd._fullData,
        fullLayout = gd._fullLayout,
        i;

    var calcdata = gd.calcdata = new Array(fullData.length);

    // extra helper variables
    // firstscatter: fill-to-next on the first trace goes to zero
    gd.firstscatter = true;

    // how many box plots do we have (in case they're grouped)
    gd.numboxes = 0;

    // for calculating avg luminosity of heatmaps
    gd._hmpixcount = 0;
    gd._hmlumcount = 0;

    // for sharing colors across pies (and for legend)
    fullLayout._piecolormap = {};
    fullLayout._piedefaultcolorcount = 0;

    // initialize the category list, if there is one, so we start over
    // to be filled in later by ax.d2c
    for(i = 0; i < axList.length; i++) {
        axList[i]._categories = axList[i]._initialCategories.slice();
    }

    for(i = 0; i < fullData.length; i++) {
        var trace = fullData[i],
            _module = trace._module,
            cd = [];

        if(_module && trace.visible === true) {
            if(_module.calc) cd = _module.calc(gd, trace);
        }

        // make sure there is a first point
        // this ensures there is a calcdata item for every trace,
        // even if cartesian logic doesn't handle it
        if(!Array.isArray(cd) || !cd[0]) cd = [{x: false, y: false}];

        // add the trace-wide properties to the first point,
        // per point properties to every point
        // t is the holder for trace-wide properties
        if(!cd[0].t) cd[0].t = {};
        cd[0].trace = trace;

        calcdata[i] = cd;
    }
}

/**
 * Wrap negative indicies to their positive counterparts.
 *
 * @param {Number[]} indices An array of indices
 * @param {Number} maxIndex The maximum index allowable (arr.length - 1)
 */
function positivifyIndices(indices, maxIndex) {
    var parentLength = maxIndex + 1,
        positiveIndices = [],
        i,
        index;

    for(i = 0; i < indices.length; i++) {
        index = indices[i];
        if(index < 0) {
            positiveIndices.push(parentLength + index);
        } else {
            positiveIndices.push(index);
        }
    }
    return positiveIndices;
}

/**
 * Ensures that an index array for manipulating gd.data is valid.
 *
 * Intended for use with addTraces, deleteTraces, and moveTraces.
 *
 * @param gd
 * @param indices
 * @param arrayName
 */
function assertIndexArray(gd, indices, arrayName) {
    var i,
        index;

    for(i = 0; i < indices.length; i++) {
        index = indices[i];

        // validate that indices are indeed integers
        if(index !== parseInt(index, 10)) {
            throw new Error('all values in ' + arrayName + ' must be integers');
        }

        // check that all indices are in bounds for given gd.data array length
        if(index >= gd.data.length || index < -gd.data.length) {
            throw new Error(arrayName + ' must be valid indices for gd.data.');
        }

        // check that indices aren't repeated
        if(indices.indexOf(index, i + 1) > -1 ||
                index >= 0 && indices.indexOf(-gd.data.length + index) > -1 ||
                index < 0 && indices.indexOf(gd.data.length + index) > -1) {
            throw new Error('each index in ' + arrayName + ' must be unique.');
        }
    }
}

/**
 * Private function used by Plotly.moveTraces to check input args
 *
 * @param gd
 * @param currentIndices
 * @param newIndices
 */
function checkMoveTracesArgs(gd, currentIndices, newIndices) {

    // check that gd has attribute 'data' and 'data' is array
    if(!Array.isArray(gd.data)) {
        throw new Error('gd.data must be an array.');
    }

    // validate currentIndices array
    if(typeof currentIndices === 'undefined') {
        throw new Error('currentIndices is a required argument.');
    } else if(!Array.isArray(currentIndices)) {
        currentIndices = [currentIndices];
    }
    assertIndexArray(gd, currentIndices, 'currentIndices');

    // validate newIndices array if it exists
    if(typeof newIndices !== 'undefined' && !Array.isArray(newIndices)) {
        newIndices = [newIndices];
    }
    if(typeof newIndices !== 'undefined') {
        assertIndexArray(gd, newIndices, 'newIndices');
    }

    // check currentIndices and newIndices are the same length if newIdices exists
    if(typeof newIndices !== 'undefined' && currentIndices.length !== newIndices.length) {
        throw new Error('current and new indices must be of equal length.');
    }

}
/**
 * A private function to reduce the type checking clutter in addTraces.
 *
 * @param gd
 * @param traces
 * @param newIndices
 */
function checkAddTracesArgs(gd, traces, newIndices) {
    var i,
        value;

    // check that gd has attribute 'data' and 'data' is array
    if(!Array.isArray(gd.data)) {
        throw new Error('gd.data must be an array.');
    }

    // make sure traces exists
    if(typeof traces === 'undefined') {
        throw new Error('traces must be defined.');
    }

    // make sure traces is an array
    if(!Array.isArray(traces)) {
        traces = [traces];
    }

    // make sure each value in traces is an object
    for(i = 0; i < traces.length; i++) {
        value = traces[i];
        if(typeof value !== 'object' || (Array.isArray(value) || value === null)) {
            throw new Error('all values in traces array must be non-array objects');
        }
    }

    // make sure we have an index for each trace
    if(typeof newIndices !== 'undefined' && !Array.isArray(newIndices)) {
        newIndices = [newIndices];
    }
    if(typeof newIndices !== 'undefined' && newIndices.length !== traces.length) {
        throw new Error(
            'if indices is specified, traces.length must equal indices.length'
        );
    }
}

/**
 * A private function to reduce the type checking clutter in spliceTraces.
 * Get all update Properties from gd.data. Validate inputs and outputs.
 * Used by prependTrace and extendTraces
 *
 * @param gd
 * @param update
 * @param indices
 * @param maxPoints
 */
function assertExtendTracesArgs(gd, update, indices, maxPoints) {

    var maxPointsIsObject = Lib.isPlainObject(maxPoints);

    if(!Array.isArray(gd.data)) {
        throw new Error('gd.data must be an array');
    }
    if(!Lib.isPlainObject(update)) {
        throw new Error('update must be a key:value object');
    }

    if(typeof indices === 'undefined') {
        throw new Error('indices must be an integer or array of integers');
    }

    assertIndexArray(gd, indices, 'indices');

    for(var key in update) {

        /*
         * Verify that the attribute to be updated contains as many trace updates
         * as indices. Failure must result in throw and no-op
         */
        if(!Array.isArray(update[key]) || update[key].length !== indices.length) {
            throw new Error('attribute ' + key + ' must be an array of length equal to indices array length');
        }

        /*
         * if maxPoints is an object it must match keys and array lengths of 'update' 1:1
         */
        if(maxPointsIsObject &&
            (!(key in maxPoints) || !Array.isArray(maxPoints[key]) ||
            maxPoints[key].length !== update[key].length)) {
            throw new Error('when maxPoints is set as a key:value object it must contain a 1:1 ' +
                            'corrispondence with the keys and number of traces in the update object');
        }
    }
}

/**
 * A private function to reduce the type checking clutter in spliceTraces.
 *
 * @param {Object|HTMLDivElement} gd
 * @param {Object} update
 * @param {Number[]} indices
 * @param {Number||Object} maxPoints
 * @return {Object[]}
 */
function getExtendProperties(gd, update, indices, maxPoints) {

    var maxPointsIsObject = Lib.isPlainObject(maxPoints),
        updateProps = [];
    var trace, target, prop, insert, maxp;

    // allow scalar index to represent a single trace position
    if(!Array.isArray(indices)) indices = [indices];

    // negative indices are wrapped around to their positive value. Equivalent to python indexing.
    indices = positivifyIndices(indices, gd.data.length - 1);

    // loop through all update keys and traces and harvest validated data.
    for(var key in update) {

        for(var j = 0; j < indices.length; j++) {

            /*
             * Choose the trace indexed by the indices map argument and get the prop setter-getter
             * instance that references the key and value for this particular trace.
             */
            trace = gd.data[indices[j]];
            prop = Lib.nestedProperty(trace, key);

            /*
             * Target is the existing gd.data.trace.dataArray value like "x" or "marker.size"
             * Target must exist as an Array to allow the extend operation to be performed.
             */
            target = prop.get();
            insert = update[key][j];

            if(!Array.isArray(insert)) {
                throw new Error('attribute: ' + key + ' index: ' + j + ' must be an array');
            }
            if(!Array.isArray(target)) {
                throw new Error('cannot extend missing or non-array attribute: ' + key);
            }

            /*
             * maxPoints may be an object map or a scalar. If object select the key:value, else
             * Use the scalar maxPoints for all key and trace combinations.
             */
            maxp = maxPointsIsObject ? maxPoints[key][j] : maxPoints;

            // could have chosen null here, -1 just tells us to not take a window
            if(!isNumeric(maxp)) maxp = -1;

            /*
             * Wrap the nestedProperty in an object containing required data
             * for lengthening and windowing this particular trace - key combination.
             * Flooring maxp mirrors the behaviour of floats in the Array.slice JSnative function.
             */
            updateProps.push({
                prop: prop,
                target: target,
                insert: insert,
                maxp: Math.floor(maxp)
            });
        }
    }

    // all target and insertion data now validated
    return updateProps;
}

/**
 * A private function to key Extend and Prepend traces DRY
 *
 * @param {Object|HTMLDivElement} gd
 * @param {Object} update
 * @param {Number[]} indices
 * @param {Number||Object} maxPoints
 * @param {Function} lengthenArray
 * @param {Function} spliceArray
 * @return {Object}
 */
function spliceTraces(gd, update, indices, maxPoints, lengthenArray, spliceArray) {

    assertExtendTracesArgs(gd, update, indices, maxPoints);

    var updateProps = getExtendProperties(gd, update, indices, maxPoints),
        remainder = [],
        undoUpdate = {},
        undoPoints = {};
    var target, prop, maxp;

    for(var i = 0; i < updateProps.length; i++) {

        /*
         * prop is the object returned by Lib.nestedProperties
         */
        prop = updateProps[i].prop;
        maxp = updateProps[i].maxp;

        target = lengthenArray(updateProps[i].target, updateProps[i].insert);

        /*
         * If maxp is set within post-extension trace.length, splice to maxp length.
         * Otherwise skip function call as splice op will have no effect anyway.
         */
        if(maxp >= 0 && maxp < target.length) remainder = spliceArray(target, maxp);

        /*
         * to reverse this operation we need the size of the original trace as the reverse
         * operation will need to window out any lengthening operation performed in this pass.
         */
        maxp = updateProps[i].target.length;

        /*
         * Magic happens here! update gd.data.trace[key] with new array data.
         */
        prop.set(target);

        if(!Array.isArray(undoUpdate[prop.astr])) undoUpdate[prop.astr] = [];
        if(!Array.isArray(undoPoints[prop.astr])) undoPoints[prop.astr] = [];

        /*
         * build the inverse update object for the undo operation
         */
        undoUpdate[prop.astr].push(remainder);

        /*
         * build the matching maxPoints undo object containing original trace lengths.
         */
        undoPoints[prop.astr].push(maxp);
    }

    return {update: undoUpdate, maxPoints: undoPoints};
}

/**
 * extend && prepend traces at indices with update arrays, window trace lengths to maxPoints
 *
 * Extend and Prepend have identical APIs. Prepend inserts an array at the head while Extend
 * inserts an array off the tail. Prepend truncates the tail of the array - counting maxPoints
 * from the head, whereas Extend truncates the head of the array, counting backward maxPoints
 * from the tail.
 *
 * If maxPoints is undefined, nonNumeric, negative or greater than extended trace length no
 * truncation / windowing will be performed. If its zero, well the whole trace is truncated.
 *
 * @param {Object|HTMLDivElement} gd The graph div
 * @param {Object} update The key:array map of target attributes to extend
 * @param {Number|Number[]} indices The locations of traces to be extended
 * @param {Number|Object} [maxPoints] Number of points for trace window after lengthening.
 *
 */
Plotly.extendTraces = function extendTraces(gd, update, indices, maxPoints) {
    gd = helpers.getGraphDiv(gd);

    var undo = spliceTraces(gd, update, indices, maxPoints,

                           /*
                            * The Lengthen operation extends trace from end with insert
                            */
                            function(target, insert) {
                                return target.concat(insert);
                            },

                            /*
                             * Window the trace keeping maxPoints, counting back from the end
                             */
                            function(target, maxPoints) {
                                return target.splice(0, target.length - maxPoints);
                            });

    var promise = Plotly.redraw(gd);

    var undoArgs = [gd, undo.update, indices, undo.maxPoints];
    Queue.add(gd, Plotly.prependTraces, undoArgs, extendTraces, arguments);

    return promise;
};

Plotly.prependTraces = function prependTraces(gd, update, indices, maxPoints) {
    gd = helpers.getGraphDiv(gd);

    var undo = spliceTraces(gd, update, indices, maxPoints,

                           /*
                            * The Lengthen operation extends trace by appending insert to start
                            */
                            function(target, insert) {
                                return insert.concat(target);
                            },

                            /*
                             * Window the trace keeping maxPoints, counting forward from the start
                             */
                            function(target, maxPoints) {
                                return target.splice(maxPoints, target.length);
                            });

    var promise = Plotly.redraw(gd);

    var undoArgs = [gd, undo.update, indices, undo.maxPoints];
    Queue.add(gd, Plotly.extendTraces, undoArgs, prependTraces, arguments);

    return promise;
};

/**
 * Add data traces to an existing graph div.
 *
 * @param {Object|HTMLDivElement} gd The graph div
 * @param {Object[]} gd.data The array of traces we're adding to
 * @param {Object[]|Object} traces The object or array of objects to add
 * @param {Number[]|Number} [newIndices=[gd.data.length]] Locations to add traces
 *
 */
Plotly.addTraces = function addTraces(gd, traces, newIndices) {
    gd = helpers.getGraphDiv(gd);

    var currentIndices = [],
        undoFunc = Plotly.deleteTraces,
        redoFunc = addTraces,
        undoArgs = [gd, currentIndices],
        redoArgs = [gd, traces],  // no newIndices here
        i,
        promise;

    // all validation is done elsewhere to remove clutter here
    checkAddTracesArgs(gd, traces, newIndices);

    // make sure traces is an array
    if(!Array.isArray(traces)) {
        traces = [traces];
    }
    helpers.cleanData(traces, gd.data);

    // add the traces to gd.data (no redrawing yet!)
    for(i = 0; i < traces.length; i += 1) {
        gd.data.push(traces[i]);
    }

    // to continue, we need to call moveTraces which requires currentIndices
    for(i = 0; i < traces.length; i++) {
        currentIndices.push(-traces.length + i);
    }

    // if the user didn't define newIndices, they just want the traces appended
    // i.e., we can simply redraw and be done
    if(typeof newIndices === 'undefined') {
        promise = Plotly.redraw(gd);
        Queue.add(gd, undoFunc, undoArgs, redoFunc, redoArgs);
        return promise;
    }

    // make sure indices is property defined
    if(!Array.isArray(newIndices)) {
        newIndices = [newIndices];
    }

    try {

        // this is redundant, but necessary to not catch later possible errors!
        checkMoveTracesArgs(gd, currentIndices, newIndices);
    }
    catch(error) {

        // something went wrong, reset gd to be safe and rethrow error
        gd.data.splice(gd.data.length - traces.length, traces.length);
        throw error;
    }

    // if we're here, the user has defined specific places to place the new traces
    // this requires some extra work that moveTraces will do
    Queue.startSequence(gd);
    Queue.add(gd, undoFunc, undoArgs, redoFunc, redoArgs);
    promise = Plotly.moveTraces(gd, currentIndices, newIndices);
    Queue.stopSequence(gd);
    return promise;
};

/**
 * Delete traces at `indices` from gd.data array.
 *
 * @param {Object|HTMLDivElement} gd The graph div
 * @param {Object[]} gd.data The array of traces we're removing from
 * @param {Number|Number[]} indices The indices
 */
Plotly.deleteTraces = function deleteTraces(gd, indices) {
    gd = helpers.getGraphDiv(gd);

    var traces = [],
        undoFunc = Plotly.addTraces,
        redoFunc = deleteTraces,
        undoArgs = [gd, traces, indices],
        redoArgs = [gd, indices],
        i,
        deletedTrace;

    // make sure indices are defined
    if(typeof indices === 'undefined') {
        throw new Error('indices must be an integer or array of integers.');
    } else if(!Array.isArray(indices)) {
        indices = [indices];
    }
    assertIndexArray(gd, indices, 'indices');

    // convert negative indices to positive indices
    indices = positivifyIndices(indices, gd.data.length - 1);

    // we want descending here so that splicing later doesn't affect indexing
    indices.sort(Lib.sorterDes);
    for(i = 0; i < indices.length; i += 1) {
        deletedTrace = gd.data.splice(indices[i], 1)[0];
        traces.push(deletedTrace);
    }

    var promise = Plotly.redraw(gd);
    Queue.add(gd, undoFunc, undoArgs, redoFunc, redoArgs);

    return promise;
};

/**
 * Move traces at currentIndices array to locations in newIndices array.
 *
 * If newIndices is omitted, currentIndices will be moved to the end. E.g.,
 * these are equivalent:
 *
 * Plotly.moveTraces(gd, [1, 2, 3], [-3, -2, -1])
 * Plotly.moveTraces(gd, [1, 2, 3])
 *
 * @param {Object|HTMLDivElement} gd The graph div
 * @param {Object[]} gd.data The array of traces we're removing from
 * @param {Number|Number[]} currentIndices The locations of traces to be moved
 * @param {Number|Number[]} [newIndices] The locations to move traces to
 *
 * Example calls:
 *
 *      // move trace i to location x
 *      Plotly.moveTraces(gd, i, x)
 *
 *      // move trace i to end of array
 *      Plotly.moveTraces(gd, i)
 *
 *      // move traces i, j, k to end of array (i != j != k)
 *      Plotly.moveTraces(gd, [i, j, k])
 *
 *      // move traces [i, j, k] to [x, y, z] (i != j != k) (x != y != z)
 *      Plotly.moveTraces(gd, [i, j, k], [x, y, z])
 *
 *      // reorder all traces (assume there are 5--a, b, c, d, e)
 *      Plotly.moveTraces(gd, [b, d, e, a, c])  // same as 'move to end'
 */
Plotly.moveTraces = function moveTraces(gd, currentIndices, newIndices) {
    gd = helpers.getGraphDiv(gd);

    var newData = [],
        movingTraceMap = [],
        undoFunc = moveTraces,
        redoFunc = moveTraces,
        undoArgs = [gd, newIndices, currentIndices],
        redoArgs = [gd, currentIndices, newIndices],
        i;

    // to reduce complexity here, check args elsewhere
    // this throws errors where appropriate
    checkMoveTracesArgs(gd, currentIndices, newIndices);

    // make sure currentIndices is an array
    currentIndices = Array.isArray(currentIndices) ? currentIndices : [currentIndices];

    // if undefined, define newIndices to point to the end of gd.data array
    if(typeof newIndices === 'undefined') {
        newIndices = [];
        for(i = 0; i < currentIndices.length; i++) {
            newIndices.push(-currentIndices.length + i);
        }
    }

    // make sure newIndices is an array if it's user-defined
    newIndices = Array.isArray(newIndices) ? newIndices : [newIndices];

    // convert negative indices to positive indices (they're the same length)
    currentIndices = positivifyIndices(currentIndices, gd.data.length - 1);
    newIndices = positivifyIndices(newIndices, gd.data.length - 1);

    // at this point, we've coerced the index arrays into predictable forms

    // get the traces that aren't being moved around
    for(i = 0; i < gd.data.length; i++) {

        // if index isn't in currentIndices, include it in ignored!
        if(currentIndices.indexOf(i) === -1) {
            newData.push(gd.data[i]);
        }
    }

    // get a mapping of indices to moving traces
    for(i = 0; i < currentIndices.length; i++) {
        movingTraceMap.push({newIndex: newIndices[i], trace: gd.data[currentIndices[i]]});
    }

    // reorder this mapping by newIndex, ascending
    movingTraceMap.sort(function(a, b) {
        return a.newIndex - b.newIndex;
    });

    // now, add the moving traces back in, in order!
    for(i = 0; i < movingTraceMap.length; i += 1) {
        newData.splice(movingTraceMap[i].newIndex, 0, movingTraceMap[i].trace);
    }

    gd.data = newData;

    var promise = Plotly.redraw(gd);
    Queue.add(gd, undoFunc, undoArgs, redoFunc, redoArgs);

    return promise;
};

// -----------------------------------------------------
// restyle and relayout: these two control all redrawing
// for data (restyle) and everything else (relayout)
// -----------------------------------------------------

// restyle: change styling of an existing plot
// can be called two ways:
//
// restyle(gd, astr, val [,traces])
//      gd - graph div (string id or dom element)
//      astr - attribute string (like 'marker.symbol')
//      val - value to give this attribute
//      traces - integer or array of integers for the traces
//          to alter (all if omitted)
//
// restyle(gd, aobj [,traces])
//      aobj - {astr1:val1, astr2:val2...} allows setting
//          multiple attributes simultaneously
//
// val (or val1, val2... in the object form) can be an array,
// to apply different values to each trace.
// If the array is too short, it will wrap around (useful for
// style files that want to specify cyclical default values).
Plotly.restyle = function restyle(gd, astr, val, traces) {
    gd = helpers.getGraphDiv(gd);
    helpers.clearPromiseQueue(gd);

    var aobj = {};

    if(typeof astr === 'string') aobj[astr] = val;
    else if(Lib.isPlainObject(astr)) {
        aobj = astr;
        if(traces === undefined) traces = val; // the 3-arg form
    }
    else {
        Lib.warn('Restyle fail.', astr, val, traces);
        return Promise.reject();
    }

    if(Object.keys(aobj).length) gd.changed = true;

    var specs = _restyle(gd, aobj, traces),
        flags = specs.flags;

    // clear calcdata if required
    if(flags.clearCalc) gd.calcdata = undefined;

    // fill in redraw sequence
    var seq = [];

    if(flags.doFullPlot) {
        seq.push(Plotly.plot);
    }
    else {
        seq.push(Plots.previousPromises);

        Plots.supplyDefaults(gd);

        if(flags.dostyle) seq.push(doTraceStyle);
        if(flags.docolorbars) seq.push(doColorBars);
    }

    var plotDone = Lib.syncOrAsync(seq, gd);
    if(!plotDone || !plotDone.then) plotDone = Promise.resolve();

    return plotDone.then(function() {
        gd.emit('plotly_restyle', specs.eventData);
        return gd;
    });
};

function _restyle(gd, aobj, traces) {
    var fullLayout = gd._fullLayout,
        fullData = gd._fullData,
        data = gd.data,
        i;

    // fill up traces
    if(isNumeric(traces)) traces = [traces];
    else if(!Array.isArray(traces) || !traces.length) {
        traces = data.map(function(_, i) { return i; });
    }

    // initialize flags
    var flags = {
        docalc: false,
        docalcAutorange: false,
        doplot: false,
        dostyle: false,
        docolorbars: false,
        autorangeOn: false,
        clearCalc: false,
        fullReplot: false
    };

    // copies of the change (and previous values of anything affected)
    // for the undo / redo queue
    var redoit = {},
        undoit = {},
        axlist,
        flagAxForDelete = {};

    // recalcAttrs attributes need a full regeneration of calcdata
    // as well as a replot, because the right objects may not exist,
    // or autorange may need recalculating
    // in principle we generally shouldn't need to redo ALL traces... that's
    // harder though.
    var recalcAttrs = [
        'mode', 'visible', 'type', 'orientation', 'fill',
        'histfunc', 'histnorm', 'text',
        'x', 'y', 'z',
        'a', 'b', 'c',
        'xtype', 'x0', 'dx', 'ytype', 'y0', 'dy', 'xaxis', 'yaxis',
        'line.width',
        'connectgaps', 'transpose', 'zsmooth',
        'showscale', 'marker.showscale',
        'zauto', 'marker.cauto',
        'autocolorscale', 'marker.autocolorscale',
        'colorscale', 'marker.colorscale',
        'reversescale', 'marker.reversescale',
        'autobinx', 'nbinsx', 'xbins', 'xbins.start', 'xbins.end', 'xbins.size',
        'autobiny', 'nbinsy', 'ybins', 'ybins.start', 'ybins.end', 'ybins.size',
        'autocontour', 'ncontours', 'contours', 'contours.coloring',
        'error_y', 'error_y.visible', 'error_y.value', 'error_y.type',
        'error_y.traceref', 'error_y.array', 'error_y.symmetric',
        'error_y.arrayminus', 'error_y.valueminus', 'error_y.tracerefminus',
        'error_x', 'error_x.visible', 'error_x.value', 'error_x.type',
        'error_x.traceref', 'error_x.array', 'error_x.symmetric',
        'error_x.arrayminus', 'error_x.valueminus', 'error_x.tracerefminus',
        'swapxy', 'swapxyaxes', 'orientationaxes',
        'marker.colors', 'values', 'labels', 'label0', 'dlabel', 'sort',
        'textinfo', 'textposition', 'textfont.size', 'textfont.family', 'textfont.color',
        'insidetextfont.size', 'insidetextfont.family', 'insidetextfont.color',
        'outsidetextfont.size', 'outsidetextfont.family', 'outsidetextfont.color',
        'hole', 'scalegroup', 'domain', 'domain.x', 'domain.y',
        'domain.x[0]', 'domain.x[1]', 'domain.y[0]', 'domain.y[1]',
        'tilt', 'tiltaxis', 'depth', 'direction', 'rotation', 'pull',
        'line.showscale', 'line.cauto', 'line.autocolorscale', 'line.reversescale',
        'marker.line.showscale', 'marker.line.cauto', 'marker.line.autocolorscale', 'marker.line.reversescale'
    ];

    for(i = 0; i < traces.length; i++) {
        if(Registry.traceIs(fullData[traces[i]], 'box')) {
            recalcAttrs.push('name');
            break;
        }
    }

    // autorangeAttrs attributes need a full redo of calcdata
    // only if an axis is autoranged,
    // because .calc() is where the autorange gets determined
    // TODO: could we break this out as well?
    var autorangeAttrs = [
        'marker', 'marker.size', 'textfont',
        'boxpoints', 'jitter', 'pointpos', 'whiskerwidth', 'boxmean'
    ];

    // replotAttrs attributes need a replot (because different
    // objects need to be made) but not a recalc
    var replotAttrs = [
        'zmin', 'zmax', 'zauto',
        'marker.cmin', 'marker.cmax', 'marker.cauto',
        'line.cmin', 'line.cmax',
        'marker.line.cmin', 'marker.line.cmax',
        'contours.start', 'contours.end', 'contours.size',
        'contours.showlines',
        'line', 'line.smoothing', 'line.shape',
        'error_y.width', 'error_x.width', 'error_x.copy_ystyle',
        'marker.maxdisplayed'
    ];

    // these ones may alter the axis type
    // (at least if the first trace is involved)
    var axtypeAttrs = [
        'type', 'x', 'y', 'x0', 'y0', 'orientation', 'xaxis', 'yaxis'
    ];

    var zscl = ['zmin', 'zmax'],
        xbins = ['xbins.start', 'xbins.end', 'xbins.size'],
        ybins = ['ybins.start', 'ybins.end', 'ybins.size'],
        contourAttrs = ['contours.start', 'contours.end', 'contours.size'];

    // At the moment, only cartesian, pie and ternary plot types can afford
    // to not go through a full replot
    var doPlotWhiteList = ['cartesian', 'pie', 'ternary'];
    fullLayout._basePlotModules.forEach(function(_module) {
        if(doPlotWhiteList.indexOf(_module.name) === -1) flags.docalc = true;
    });

    // make a new empty vals array for undoit
    function a0() { return traces.map(function() { return undefined; }); }

    // for autoranging multiple axes
    function addToAxlist(axid) {
        var axName = Plotly.Axes.id2name(axid);
        if(axlist.indexOf(axName) === -1) axlist.push(axName);
    }

    function autorangeAttr(axName) { return 'LAYOUT' + axName + '.autorange'; }

    function rangeAttr(axName) { return 'LAYOUT' + axName + '.range'; }

    // for attrs that interact (like scales & autoscales), save the
    // old vals before making the change
    // val=undefined will not set a value, just record what the value was.
    // val=null will delete the attribute
    // attr can be an array to set several at once (all to the same val)
    function doextra(attr, val, i) {
        if(Array.isArray(attr)) {
            attr.forEach(function(a) { doextra(a, val, i); });
            return;
        }
        // quit if explicitly setting this elsewhere
        if(attr in aobj) return;

        var extraparam;
        if(attr.substr(0, 6) === 'LAYOUT') {
            extraparam = Lib.nestedProperty(gd.layout, attr.replace('LAYOUT', ''));
        } else {
            extraparam = Lib.nestedProperty(data[traces[i]], attr);
        }

        if(!(attr in undoit)) {
            undoit[attr] = a0();
        }
        if(undoit[attr][i] === undefined) {
            undoit[attr][i] = extraparam.get();
        }
        if(val !== undefined) {
            extraparam.set(val);
        }
    }

    // now make the changes to gd.data (and occasionally gd.layout)
    // and figure out what kind of graphics update we need to do
    for(var ai in aobj) {
        var vi = aobj[ai],
            cont,
            contFull,
            param,
            oldVal,
            newVal;

        redoit[ai] = vi;

        if(ai.substr(0, 6) === 'LAYOUT') {
            param = Lib.nestedProperty(gd.layout, ai.replace('LAYOUT', ''));
            undoit[ai] = [param.get()];
            // since we're allowing val to be an array, allow it here too,
            // even though that's meaningless
            param.set(Array.isArray(vi) ? vi[0] : vi);
            // ironically, the layout attrs in restyle only require replot,
            // not relayout
            flags.docalc = true;
            continue;
        }

        // take no chances on transforms
        if(ai.substr(0, 10) === 'transforms') flags.docalc = true;

        // set attribute in gd.data
        undoit[ai] = a0();
        for(i = 0; i < traces.length; i++) {
            cont = data[traces[i]];
            contFull = fullData[traces[i]];
            param = Lib.nestedProperty(cont, ai);
            oldVal = param.get();
            newVal = Array.isArray(vi) ? vi[i % vi.length] : vi;

            if(newVal === undefined) continue;

            // setting bin or z settings should turn off auto
            // and setting auto should save bin or z settings
            if(zscl.indexOf(ai) !== -1) {
                doextra('zauto', false, i);
            }
            else if(ai === 'colorscale') {
                doextra('autocolorscale', false, i);
            }
            else if(ai === 'autocolorscale') {
                doextra('colorscale', undefined, i);
            }
            else if(ai === 'marker.colorscale') {
                doextra('marker.autocolorscale', false, i);
            }
            else if(ai === 'marker.autocolorscale') {
                doextra('marker.colorscale', undefined, i);
            }
            else if(ai === 'zauto') {
                doextra(zscl, undefined, i);
            }
            else if(xbins.indexOf(ai) !== -1) {
                doextra('autobinx', false, i);
            }
            else if(ai === 'autobinx') {
                doextra(xbins, undefined, i);
            }
            else if(ybins.indexOf(ai) !== -1) {
                doextra('autobiny', false, i);
            }
            else if(ai === 'autobiny') {
                doextra(ybins, undefined, i);
            }
            else if(contourAttrs.indexOf(ai) !== -1) {
                doextra('autocontour', false, i);
            }
            else if(ai === 'autocontour') {
                doextra(contourAttrs, undefined, i);
            }
            // heatmaps: setting x0 or dx, y0 or dy,
            // should turn xtype/ytype to 'scaled' if 'array'
            else if(['x0', 'dx'].indexOf(ai) !== -1 &&
                    contFull.x && contFull.xtype !== 'scaled') {
                doextra('xtype', 'scaled', i);
            }
            else if(['y0', 'dy'].indexOf(ai) !== -1 &&
                    contFull.y && contFull.ytype !== 'scaled') {
                doextra('ytype', 'scaled', i);
            }
            // changing colorbar size modes,
            // make the resulting size not change
            // note that colorbar fractional sizing is based on the
            // original plot size, before anything (like a colorbar)
            // increases the margins
            else if(ai === 'colorbar.thicknessmode' && param.get() !== newVal &&
                        ['fraction', 'pixels'].indexOf(newVal) !== -1 &&
                        contFull.colorbar) {
                var thicknorm =
                    ['top', 'bottom'].indexOf(contFull.colorbar.orient) !== -1 ?
                        (fullLayout.height - fullLayout.margin.t - fullLayout.margin.b) :
                        (fullLayout.width - fullLayout.margin.l - fullLayout.margin.r);
                doextra('colorbar.thickness', contFull.colorbar.thickness *
                    (newVal === 'fraction' ? 1 / thicknorm : thicknorm), i);
            }
            else if(ai === 'colorbar.lenmode' && param.get() !== newVal &&
                        ['fraction', 'pixels'].indexOf(newVal) !== -1 &&
                        contFull.colorbar) {
                var lennorm =
                    ['top', 'bottom'].indexOf(contFull.colorbar.orient) !== -1 ?
                        (fullLayout.width - fullLayout.margin.l - fullLayout.margin.r) :
                        (fullLayout.height - fullLayout.margin.t - fullLayout.margin.b);
                doextra('colorbar.len', contFull.colorbar.len *
                    (newVal === 'fraction' ? 1 / lennorm : lennorm), i);
            }
            else if(ai === 'colorbar.tick0' || ai === 'colorbar.dtick') {
                doextra('colorbar.tickmode', 'linear', i);
            }
            else if(ai === 'colorbar.tickmode') {
                doextra(['colorbar.tick0', 'colorbar.dtick'], undefined, i);
            }


            if(ai === 'type' && (newVal === 'pie') !== (oldVal === 'pie')) {
                var labelsTo = 'x',
                    valuesTo = 'y';
                if((newVal === 'bar' || oldVal === 'bar') && cont.orientation === 'h') {
                    labelsTo = 'y';
                    valuesTo = 'x';
                }
                Lib.swapAttrs(cont, ['?', '?src'], 'labels', labelsTo);
                Lib.swapAttrs(cont, ['d?', '?0'], 'label', labelsTo);
                Lib.swapAttrs(cont, ['?', '?src'], 'values', valuesTo);

                if(oldVal === 'pie') {
                    Lib.nestedProperty(cont, 'marker.color')
                        .set(Lib.nestedProperty(cont, 'marker.colors').get());

                    // super kludgy - but if all pies are gone we won't remove them otherwise
                    fullLayout._pielayer.selectAll('g.trace').remove();
                } else if(Registry.traceIs(cont, 'cartesian')) {
                    Lib.nestedProperty(cont, 'marker.colors')
                        .set(Lib.nestedProperty(cont, 'marker.color').get());
                    //look for axes that are no longer in use and delete them
                    flagAxForDelete[cont.xaxis || 'x'] = true;
                    flagAxForDelete[cont.yaxis || 'y'] = true;
                }
            }

            undoit[ai][i] = oldVal;
            // set the new value - if val is an array, it's one el per trace
            // first check for attributes that get more complex alterations
            var swapAttrs = [
                'swapxy', 'swapxyaxes', 'orientation', 'orientationaxes'
            ];
            if(swapAttrs.indexOf(ai) !== -1) {
                // setting an orientation: make sure it's changing
                // before we swap everything else
                if(ai === 'orientation') {
                    param.set(newVal);
                    if(param.get() === undoit[ai][i]) continue;
                }
                // orientationaxes has no value,
                // it flips everything and the axes
                else if(ai === 'orientationaxes') {
                    cont.orientation =
                        {v: 'h', h: 'v'}[contFull.orientation];
                }
                helpers.swapXYData(cont);
            }
            // all the other ones, just modify that one attribute
            else param.set(newVal);

        }

        // swap the data attributes of the relevant x and y axes?
        if(['swapxyaxes', 'orientationaxes'].indexOf(ai) !== -1) {
            Plotly.Axes.swap(gd, traces);
        }

        // swap hovermode if set to "compare x/y data"
        if(ai === 'orientationaxes') {
            var hovermode = Lib.nestedProperty(gd.layout, 'hovermode');
            if(hovermode.get() === 'x') {
                hovermode.set('y');
            } else if(hovermode.get() === 'y') {
                hovermode.set('x');
            }
        }

        // check if we need to call axis type
        if((traces.indexOf(0) !== -1) && (axtypeAttrs.indexOf(ai) !== -1)) {
            Plotly.Axes.clearTypes(gd, traces);
            flags.docalc = true;
        }

        // switching from auto to manual binning or z scaling doesn't
        // actually do anything but change what you see in the styling
        // box. everything else at least needs to apply styles
        if((['autobinx', 'autobiny', 'zauto'].indexOf(ai) === -1) ||
                newVal !== false) {
            flags.dostyle = true;
        }
        if(['colorbar', 'line'].indexOf(param.parts[0]) !== -1 ||
            param.parts[0] === 'marker' && param.parts[1] === 'colorbar') {
            flags.docolorbars = true;
        }

        if(recalcAttrs.indexOf(ai) !== -1) {
            // major enough changes deserve autoscale, autobin, and
            // non-reversed axes so people don't get confused
            if(['orientation', 'type'].indexOf(ai) !== -1) {
                axlist = [];
                for(i = 0; i < traces.length; i++) {
                    var trace = data[traces[i]];

                    if(Registry.traceIs(trace, 'cartesian')) {
                        addToAxlist(trace.xaxis || 'x');
                        addToAxlist(trace.yaxis || 'y');

                        if(ai === 'type') {
                            doextra(['autobinx', 'autobiny'], true, i);
                        }
                    }
                }

                doextra(axlist.map(autorangeAttr), true, 0);
                doextra(axlist.map(rangeAttr), [0, 1], 0);
            }
            flags.docalc = true;
        }
        else if(replotAttrs.indexOf(ai) !== -1) flags.doplot = true;
        else if(autorangeAttrs.indexOf(ai) !== -1) flags.docalcAutorange = true;
    }

    // do we need to force a recalc?
    Plotly.Axes.list(gd).forEach(function(ax) {
        if(ax.autorange) flags.autorangeOn = true;
    });

    // check axes we've flagged for possible deletion
    // flagAxForDelete is a hash so we can make sure we only get each axis once
    var axListForDelete = Object.keys(flagAxForDelete);
    axisLoop:
    for(i = 0; i < axListForDelete.length; i++) {
        var axId = axListForDelete[i],
            axLetter = axId.charAt(0),
            axAttr = axLetter + 'axis';

        for(var j = 0; j < data.length; j++) {
            if(Registry.traceIs(data[j], 'cartesian') &&
                    (data[j][axAttr] || axLetter) === axId) {
                continue axisLoop;
            }
        }

        // no data on this axis - delete it.
        doextra('LAYOUT' + Plotly.Axes.id2name(axId), null, 0);
    }

    // combine a few flags together;
    if(flags.docalc || (flags.docalcAutorange && flags.autorangeOn)) {
        flags.clearCalc = true;
    }
    if(flags.docalc || flags.doplot || flags.docalcAutorange) {
        flags.fullReplot = true;
    }

    // now all attribute mods are done, as are redo and undo
    // so we can save them
    Queue.add(gd, Plotly.restyle, [gd, undoit, traces], Plotly.restyle, [gd, redoit, traces]);

    return {
        flags: flags,
        eventData: Lib.extendDeepNoArrays([], [redoit, traces])
    };
}

// relayout: change layout in an existing plot
// can be called two ways:
//
// relayout(gd, astr, val)
//      gd - graph div (string id or dom element)
//      astr - attribute string (like 'xaxis.range[0]')
//      val - value to give this attribute
//
// relayout(gd,aobj)
//      aobj - {astr1:val1, astr2:val2...}
//          allows setting multiple attributes simultaneously
Plotly.relayout = function relayout(gd, astr, val) {
    gd = helpers.getGraphDiv(gd);
    helpers.clearPromiseQueue(gd);

    if(gd.framework && gd.framework.isPolar) {
        return Promise.resolve(gd);
    }

    var aobj = {};
    if(typeof astr === 'string') aobj[astr] = val;
    else if(Lib.isPlainObject(astr)) aobj = astr;
    else {
        Lib.warn('Relayout fail.', astr, val);
        return Promise.reject();
    }

    if(Object.keys(aobj).length) gd.changed = true;

    var specs = _relayout(gd, aobj),
        flags = specs.flags;

    // clear calcdata if required
    if(flags.docalc) gd.calcdata = undefined;

    // fill in redraw sequence
    var seq = [];

    if(flags.layoutReplot) {
        seq.push(layoutReplot);
    }
    else if(Object.keys(aobj).length) {
        seq.push(Plots.previousPromises);
        Plots.supplyDefaults(gd);

        if(flags.dolegend) seq.push(doLegend);
        if(flags.dolayoutstyle) seq.push(layoutStyles);
        if(flags.doticks) seq.push(doTicksRelayout);
        if(flags.domodebar) seq.push(doModeBar);
    }

    var plotDone = Lib.syncOrAsync(seq, gd);
    if(!plotDone || !plotDone.then) plotDone = Promise.resolve(gd);

    return plotDone.then(function() {
        setRangeSliderRange(gd, specs.eventData);
        gd.emit('plotly_relayout', specs.eventData);
        return gd;
    });
};

function _relayout(gd, aobj) {
    var layout = gd.layout,
        fullLayout = gd._fullLayout,
        keys = Object.keys(aobj),
        axes = Plotly.Axes.list(gd),
        i;

    // look for 'allaxes', split out into all axes
    // in case of 3D the axis are nested within a scene which is held in _id
    for(i = 0; i < keys.length; i++) {
        if(keys[i].indexOf('allaxes') === 0) {
            for(var j = 0; j < axes.length; j++) {
                var scene = axes[j]._id.substr(1),
                    axisAttr = (scene.indexOf('scene') !== -1) ? (scene + '.') : '',
                    newkey = keys[i].replace('allaxes', axisAttr + axes[j]._name);

                if(!aobj[newkey]) aobj[newkey] = aobj[keys[i]];
            }

            delete aobj[keys[i]];
        }
    }

    // initialize flags
    var flags = {
        dolegend: false,
        doticks: false,
        dolayoutstyle: false,
        doplot: false,
        docalc: false,
        domodebar: false,
        layoutReplot: false
    };

    // copies of the change (and previous values of anything affected)
    // for the undo / redo queue
    var redoit = {},
        undoit = {};

    var hw = ['height', 'width'];

    // for attrs that interact (like scales & autoscales), save the
    // old vals before making the change
    // val=undefined will not set a value, just record what the value was.
    // attr can be an array to set several at once (all to the same val)
    function doextra(attr, val) {
        if(Array.isArray(attr)) {
            attr.forEach(function(a) { doextra(a, val); });
            return;
        }
        // quit if explicitly setting this elsewhere
        if(attr in aobj) return;

        var p = Lib.nestedProperty(layout, attr);
        if(!(attr in undoit)) undoit[attr] = p.get();
        if(val !== undefined) p.set(val);
    }

    // for editing annotations or shapes - is it on autoscaled axes?
    function refAutorange(obj, axletter) {
        var axName = Plotly.Axes.id2name(obj[axletter + 'ref'] || axletter);
        return (fullLayout[axName] || {}).autorange;
    }

    // alter gd.layout
    for(var ai in aobj) {
        var p = Lib.nestedProperty(layout, ai),
            vi = aobj[ai],
            plen = p.parts.length,
            // p.parts may end with an index integer if the property is an array
            pend = typeof p.parts[plen - 1] === 'string' ? (plen - 1) : (plen - 2),
            // last property in chain (leaf node)
            pleaf = p.parts[pend],
            // leaf plus immediate parent
            pleafPlus = p.parts[pend - 1] + '.' + pleaf,
            // trunk nodes (everything except the leaf)
            ptrunk = p.parts.slice(0, pend).join('.'),
            parentIn = Lib.nestedProperty(gd.layout, ptrunk).get(),
            parentFull = Lib.nestedProperty(fullLayout, ptrunk).get(),
            diff;

        if(vi === undefined) continue;

        redoit[ai] = vi;

        // axis reverse is special - it is its own inverse
        // op and has no flag.
        undoit[ai] = (pleaf === 'reverse') ? vi : p.get();

        // check autosize or autorange vs size and range
        if(hw.indexOf(ai) !== -1) {
            doextra('autosize', false);
        }
        else if(ai === 'autosize') {
            doextra(hw, undefined);
        }
        else if(pleafPlus.match(/^[xyz]axis[0-9]*\.range(\[[0|1]\])?$/)) {
            doextra(ptrunk + '.autorange', false);
        }
        else if(pleafPlus.match(/^[xyz]axis[0-9]*\.autorange$/)) {
            doextra([ptrunk + '.range[0]', ptrunk + '.range[1]'],
                undefined);
        }
        else if(pleafPlus.match(/^aspectratio\.[xyz]$/)) {
            doextra(p.parts[0] + '.aspectmode', 'manual');
        }
        else if(pleafPlus.match(/^aspectmode$/)) {
            doextra([ptrunk + '.x', ptrunk + '.y', ptrunk + '.z'], undefined);
        }
        else if(pleaf === 'tick0' || pleaf === 'dtick') {
            doextra(ptrunk + '.tickmode', 'linear');
        }
        else if(pleaf === 'tickmode') {
            doextra([ptrunk + '.tick0', ptrunk + '.dtick'], undefined);
        }
        else if(/[xy]axis[0-9]*?$/.test(pleaf) && !Object.keys(vi || {}).length) {
            flags.docalc = true;
        }
        else if(/[xy]axis[0-9]*\.categoryorder$/.test(pleafPlus)) {
            flags.docalc = true;
        }
        else if(/[xy]axis[0-9]*\.categoryarray/.test(pleafPlus)) {
            flags.docalc = true;
        }

        if(pleafPlus.indexOf('rangeslider') !== -1) {
            flags.docalc = true;
        }

        // toggling log without autorange: need to also recalculate ranges
        // logical XOR (ie are we toggling log)
        if(pleaf === 'type' && ((parentFull.type === 'log') !== (vi === 'log'))) {
            var ax = parentIn;

            if(!ax || !ax.range) {
                doextra(ptrunk + '.autorange', true);
            }
            else if(!parentFull.autorange) {
                var r0 = ax.range[0],
                    r1 = ax.range[1];
                if(vi === 'log') {
                    // if both limits are negative, autorange
                    if(r0 <= 0 && r1 <= 0) {
                        doextra(ptrunk + '.autorange', true);
                    }
                    // if one is negative, set it 6 orders below the other.
                    if(r0 <= 0) r0 = r1 / 1e6;
                    else if(r1 <= 0) r1 = r0 / 1e6;
                    // now set the range values as appropriate
                    doextra(ptrunk + '.range[0]', Math.log(r0) / Math.LN10);
                    doextra(ptrunk + '.range[1]', Math.log(r1) / Math.LN10);
                }
                else {
                    doextra(ptrunk + '.range[0]', Math.pow(10, r0));
                    doextra(ptrunk + '.range[1]', Math.pow(10, r1));
                }
            }
            else if(vi === 'log') {
                // just make sure the range is positive and in the right
                // order, it'll get recalculated later
                ax.range = (ax.range[1] > ax.range[0]) ? [1, 2] : [2, 1];
            }
        }

        // handle axis reversal explicitly, as there's no 'reverse' flag
        if(pleaf === 'reverse') {
            if(parentIn.range) parentIn.range.reverse();
            else {
                doextra(ptrunk + '.autorange', true);
                parentIn.range = [1, 0];
            }

            if(parentFull.autorange) flags.docalc = true;
            else flags.doplot = true;
        }
        // send annotation and shape mods one-by-one through Annotations.draw(),
        // don't set via nestedProperty
        // that's because add and remove are special
        else if(p.parts[0] === 'annotations' || p.parts[0] === 'shapes') {
            var objNum = p.parts[1],
                objType = p.parts[0],
                objList = layout[objType] || [],
                obji = objList[objNum] || {};

            // if p.parts is just an annotation number, and val is either
            // 'add' or an entire annotation to add, the undo is 'remove'
            // if val is 'remove' then undo is the whole annotation object
            if(p.parts.length === 2) {
                if(aobj[ai] === 'add' || Lib.isPlainObject(aobj[ai])) {
                    undoit[ai] = 'remove';
                }
                else if(aobj[ai] === 'remove') {
                    if(objNum === -1) {
                        undoit[objType] = objList;
                        delete undoit[ai];
                    }
                    else undoit[ai] = obji;
                }
                else Lib.log('???', aobj);
            }

            if((refAutorange(obji, 'x') || refAutorange(obji, 'y')) &&
                    !Lib.containsAny(ai, ['color', 'opacity', 'align', 'dash'])) {
                flags.docalc = true;
            }

            // TODO: combine all edits to a given annotation / shape into one call
            // as it is we get separate calls for x and y (or ax and ay) on move

            var drawOne = Registry.getComponentMethod(objType, 'drawOne');
            drawOne(gd, objNum, p.parts.slice(2).join('.'), aobj[ai]);
            delete aobj[ai];
        }
        else if(p.parts[0] === 'images') {
            var update = Lib.objectFromPath(ai, vi);
            Lib.extendDeepAll(gd.layout, update);

            Registry.getComponentMethod('images', 'supplyLayoutDefaults')(gd.layout, gd._fullLayout);
            Registry.getComponentMethod('images', 'draw')(gd);
        }
        else if(p.parts[0] === 'mapbox' && p.parts[1] === 'layers') {
            Lib.extendDeepAll(gd.layout, Lib.objectFromPath(ai, vi));

            // append empty container to mapbox.layers
            // so that relinkPrivateKeys does not complain

            var fullLayers = (gd._fullLayout.mapbox || {}).layers || [];
            diff = (p.parts[2] + 1) - fullLayers.length;

            for(i = 0; i < diff; i++) fullLayers.push({});

            flags.doplot = true;
        }
        else if(p.parts[0] === 'updatemenus') {
            Lib.extendDeepAll(gd.layout, Lib.objectFromPath(ai, vi));

            var menus = gd._fullLayout.updatemenus || [];
            diff = (p.parts[2] + 1) - menus.length;

            for(i = 0; i < diff; i++) menus.push({});
            flags.doplot = true;
        }
        // alter gd.layout
        else {
            // check whether we can short-circuit a full redraw
            // 3d or geo at this point just needs to redraw.
            if(p.parts[0].indexOf('scene') === 0) flags.doplot = true;
            else if(p.parts[0].indexOf('geo') === 0) flags.doplot = true;
            else if(p.parts[0].indexOf('ternary') === 0) flags.doplot = true;
            else if(fullLayout._has('gl2d') &&
                (ai.indexOf('axis') !== -1 || p.parts[0] === 'plot_bgcolor')
            ) flags.doplot = true;
            else if(ai === 'hiddenlabels') flags.docalc = true;
            else if(p.parts[0].indexOf('legend') !== -1) flags.dolegend = true;
            else if(ai.indexOf('title') !== -1) flags.doticks = true;
            else if(p.parts[0].indexOf('bgcolor') !== -1) flags.dolayoutstyle = true;
            else if(p.parts.length > 1 &&
                    Lib.containsAny(p.parts[1], ['tick', 'exponent', 'grid', 'zeroline'])) {
                flags.doticks = true;
            }
            else if(ai.indexOf('.linewidth') !== -1 &&
                    ai.indexOf('axis') !== -1) {
                flags.doticks = flags.dolayoutstyle = true;
            }
            else if(p.parts.length > 1 && p.parts[1].indexOf('line') !== -1) {
                flags.dolayoutstyle = true;
            }
            else if(p.parts.length > 1 && p.parts[1] === 'mirror') {
                flags.doticks = flags.dolayoutstyle = true;
            }
            else if(ai === 'margin.pad') {
                flags.doticks = flags.dolayoutstyle = true;
            }
            else if(p.parts[0] === 'margin' ||
                    p.parts[1] === 'autorange' ||
                    p.parts[1] === 'rangemode' ||
                    p.parts[1] === 'type' ||
                    p.parts[1] === 'domain' ||
                    ai.match(/^(bar|box|font)/)) {
                flags.docalc = true;
            }
            /*
             * hovermode and dragmode don't need any redrawing, since they just
             * affect reaction to user input, everything else, assume full replot.
             * height, width, autosize get dealt with below. Except for the case of
             * of subplots - scenes - which require scene.updateFx to be called.
             */
            else if(['hovermode', 'dragmode'].indexOf(ai) !== -1) flags.domodebar = true;
            else if(['hovermode', 'dragmode', 'height',
                    'width', 'autosize'].indexOf(ai) === -1) {
                flags.doplot = true;
            }

            p.set(vi);
        }
    }

    // calculate autosizing - if size hasn't changed,
    // will remove h&w so we don't need to redraw
    if(aobj.autosize) aobj = plotAutoSize(gd, aobj);
    if(aobj.height || aobj.width || aobj.autosize) flags.docalc = true;

    if(flags.doplot || flags.docalc) {
        flags.layoutReplot = true;
    }

    // now all attribute mods are done, as are
    // redo and undo so we can save them
    Queue.add(gd, Plotly.relayout, [gd, undoit], Plotly.relayout, [gd, redoit]);

    return {
        flags: flags,
        eventData: Lib.extendDeep({}, redoit)
    };
}

Plotly.update = function(gd, traceUpdate, layoutUpdate, indices) {
    gd = helpers.getGraphDiv(gd);
    helpers.clearPromiseQueue(gd);

    if(gd.framework && gd.framework.isPolar) {
        return Promise.resolve(gd);
    }

    if(Object.keys(traceUpdate).length && Object.keys(layoutUpdate)) {
        gd.changed = true;
    }

    var restyleSpecs = _restyle(gd, traceUpdate, indices),
        restyleFlags = restyleSpecs.flags;

    var relayoutSpecs = _relayout(gd, layoutUpdate),
        relayoutFlags = relayoutSpecs.flags;

    // clear calcdata if required
    if(restyleFlags.clearCalc || relayoutFlags.docalc) gd.calcdata = undefined;

    // fill in redraw sequence
    var seq = [];

    if(restyleFlags.fullReplot && relayoutFlags.layoutReplot) {
        gd.layout = undefined;
        seq.push(function() { return Plotly.plot(gd, gd.data, gd.layou); });
    }
    else if(restyleFlags.fullReplot) {
        seq.push(Plotly.plot);
    }
    else if(relayoutFlags.layoutReplot) {
        seq.push(layoutReplot);
    }
    else {
        seq.push(Plots.previousPromises);
        Plots.supplyDefaults(gd);

        if(restyleFlags.dostyle) seq.push(doTraceStyle);
        if(restyleFlags.docolorbars) seq.push(doColorBars);
        if(relayoutFlags.dolegend) seq.push(doLegend);
        if(relayoutFlags.dolayoutstyle) seq.push(layoutStyles);
        if(relayoutFlags.doticks) seq.push(doTicksRelayout);
        if(relayoutFlags.domodebar) seq.push(doModeBar);
    }

    var plotDone = Lib.syncOrAsync(seq, gd);
    if(!plotDone || !plotDone.then) plotDone = Promise.resolve(gd);

    return plotDone.then(function() {
        setRangeSliderRange(gd, relayoutSpecs.eventData);

        gd.emit('plotly_update', {
            data: restyleSpecs.eventData,
            layout: relayoutSpecs.eventData
        });

        return gd;
    });
};

/**
 * Purge a graph container div back to its initial pre-Plotly.plot state
 *
 * @param {string id or DOM element} gd
 *      the id or DOM element of the graph container div
 */
Plotly.purge = function purge(gd) {
    gd = helpers.getGraphDiv(gd);

    var fullLayout = gd._fullLayout || {},
        fullData = gd._fullData || [];

    // remove gl contexts
    Plots.cleanPlot([], {}, fullData, fullLayout);

    // purge properties
    Plots.purge(gd);

    // purge event emitter methods
    Events.purge(gd);

    // remove plot container
    if(fullLayout._container) fullLayout._container.remove();

    delete gd._context;
    delete gd._replotPending;
    delete gd._mouseDownTime;
    delete gd._hmpixcount;
    delete gd._hmlumcount;

    return gd;
};

/**
 * Reduce all reserved margin objects to a single required margin reservation.
 *
 * @param {Object} margins
 * @returns {{left: number, right: number, bottom: number, top: number}}
 */
function calculateReservedMargins(margins) {
    var resultingMargin = {left: 0, right: 0, bottom: 0, top: 0},
        marginName;

    if(margins) {
        for(marginName in margins) {
            if(margins.hasOwnProperty(marginName)) {
                resultingMargin.left += margins[marginName].left || 0;
                resultingMargin.right += margins[marginName].right || 0;
                resultingMargin.bottom += margins[marginName].bottom || 0;
                resultingMargin.top += margins[marginName].top || 0;
            }
        }
    }
    return resultingMargin;
}

function plotAutoSize(gd, aobj) {
    var fullLayout = gd._fullLayout,
        context = gd._context,
        computedStyle;

    var newHeight, newWidth;

    gd.emit('plotly_autosize');

    // embedded in an iframe - just take the full iframe size
    // if we get to this point, with no aspect ratio restrictions
    if(gd._context.fillFrame) {
        newWidth = window.innerWidth;
        newHeight = window.innerHeight;

        // somehow we get a few extra px height sometimes...
        // just hide it
        document.body.style.overflow = 'hidden';
    }
    else if(isNumeric(context.frameMargins) && context.frameMargins > 0) {
        var reservedMargins = calculateReservedMargins(gd._boundingBoxMargins),
            reservedWidth = reservedMargins.left + reservedMargins.right,
            reservedHeight = reservedMargins.bottom + reservedMargins.top,
            gdBB = fullLayout._container.node().getBoundingClientRect(),
            factor = 1 - 2 * context.frameMargins;

        newWidth = Math.round(factor * (gdBB.width - reservedWidth));
        newHeight = Math.round(factor * (gdBB.height - reservedHeight));
    }
    else {
        // plotly.js - let the developers do what they want, either
        // provide height and width for the container div,
        // specify size in layout, or take the defaults,
        // but don't enforce any ratio restrictions
        computedStyle = window.getComputedStyle(gd);
        newHeight = parseFloat(computedStyle.height) || fullLayout.height;
        newWidth = parseFloat(computedStyle.width) || fullLayout.width;
    }

    if(Math.abs(fullLayout.width - newWidth) > 1 ||
            Math.abs(fullLayout.height - newHeight) > 1) {
        fullLayout.height = gd.layout.height = newHeight;
        fullLayout.width = gd.layout.width = newWidth;
    }
    // if there's no size change, update layout but
    // delete the autosize attr so we don't redraw
    // but can't call layoutStyles for initial autosize
    else if(fullLayout.autosize !== 'initial') {
        delete(aobj.autosize);
        fullLayout.autosize = gd.layout.autosize = true;
    }

    Plots.sanitizeMargins(fullLayout);

    return aobj;
}

// -------------------------------------------------------
// makePlotFramework: Create the plot container and axes
// -------------------------------------------------------
function makePlotFramework(gd) {
    var gd3 = d3.select(gd),
        fullLayout = gd._fullLayout;

    // Plot container
    fullLayout._container = gd3.selectAll('.plot-container').data([0]);
    fullLayout._container.enter().insert('div', ':first-child')
        .classed('plot-container', true)
        .classed('plotly', true);

    // Make the svg container
    fullLayout._paperdiv = fullLayout._container.selectAll('.svg-container').data([0]);
    fullLayout._paperdiv.enter().append('div')
        .classed('svg-container', true)
        .style('position', 'relative');

    // Initial autosize
    if(fullLayout.autosize === 'initial') {
        plotAutoSize(gd, {});
        fullLayout.autosize = true;
        gd.layout.autosize = true;
    }

    // Make the graph containers
    // start fresh each time we get here, so we know the order comes out
    // right, rather than enter/exit which can muck up the order
    // TODO: sort out all the ordering so we don't have to
    // explicitly delete anything
    fullLayout._glcontainer = fullLayout._paperdiv.selectAll('.gl-container')
        .data([0]);
    fullLayout._glcontainer.enter().append('div')
        .classed('gl-container', true);

    fullLayout._geocontainer = fullLayout._paperdiv.selectAll('.geo-container')
        .data([0]);
    fullLayout._geocontainer.enter().append('div')
        .classed('geo-container', true);

    fullLayout._paperdiv.selectAll('.main-svg').remove();

    fullLayout._paper = fullLayout._paperdiv.insert('svg', ':first-child')
        .classed('main-svg', true);

    fullLayout._toppaper = fullLayout._paperdiv.append('svg')
        .classed('main-svg', true);

    if(!fullLayout._uid) {
        var otherUids = [];
        d3.selectAll('defs').each(function() {
            if(this.id) otherUids.push(this.id.split('-')[1]);
        });
        fullLayout._uid = Lib.randstr(otherUids);
    }

    fullLayout._paperdiv.selectAll('.main-svg')
        .attr(xmlnsNamespaces.svgAttrs);

    fullLayout._defs = fullLayout._paper.append('defs')
        .attr('id', 'defs-' + fullLayout._uid);

    fullLayout._topdefs = fullLayout._toppaper.append('defs')
        .attr('id', 'topdefs-' + fullLayout._uid);

    fullLayout._draggers = fullLayout._paper.append('g')
        .classed('draglayer', true);

    // lower shape layer
    // (only for shapes to be drawn below the whole plot)
    var layerBelow = fullLayout._paper.append('g')
        .classed('layer-below', true);
    fullLayout._imageLowerLayer = layerBelow.append('g')
        .classed('imagelayer', true);
    fullLayout._shapeLowerLayer = layerBelow.append('g')
        .classed('shapelayer', true);

    var subplots = Plotly.Axes.getSubplots(gd);
    if(subplots.join('') !== Object.keys(gd._fullLayout._plots || {}).join('')) {
        makeSubplots(gd, subplots);
    }

    if(fullLayout._has('cartesian')) makeCartesianPlotFramwork(gd, subplots);

    // single ternary layer for the whole plot
    fullLayout._ternarylayer = fullLayout._paper.append('g').classed('ternarylayer', true);

    // shape layers in subplots
    var layerSubplot = fullLayout._paper.selectAll('.layer-subplot');
    fullLayout._imageSubplotLayer = layerSubplot.selectAll('.imagelayer');
    fullLayout._shapeSubplotLayer = layerSubplot.selectAll('.shapelayer');

    // upper shape layer
    // (only for shapes to be drawn above the whole plot, including subplots)
    var layerAbove = fullLayout._paper.append('g')
        .classed('layer-above', true);
    fullLayout._imageUpperLayer = layerAbove.append('g')
        .classed('imagelayer', true);
    fullLayout._shapeUpperLayer = layerAbove.append('g')
        .classed('shapelayer', true);

    // single pie layer for the whole plot
    fullLayout._pielayer = fullLayout._paper.append('g').classed('pielayer', true);

    // fill in image server scrape-svg
    fullLayout._glimages = fullLayout._paper.append('g').classed('glimages', true);
    fullLayout._geoimages = fullLayout._paper.append('g').classed('geoimages', true);

    // lastly info (legend, annotations) and hover layers go on top
    // these are in a different svg element normally, but get collapsed into a single
    // svg when exporting (after inserting 3D)
    fullLayout._infolayer = fullLayout._toppaper.append('g').classed('infolayer', true);
    fullLayout._zoomlayer = fullLayout._toppaper.append('g').classed('zoomlayer', true);
    fullLayout._hoverlayer = fullLayout._toppaper.append('g').classed('hoverlayer', true);

    gd.emit('plotly_framework');

    // position and style the containers, make main title
    var frameWorkDone = Lib.syncOrAsync([
        layoutStyles,
        function goAxes() { return Plotly.Axes.doTicks(gd, 'redraw'); },
        Fx.init
    ], gd);

    if(frameWorkDone && frameWorkDone.then) {
        gd._promises.push(frameWorkDone);
    }

    return frameWorkDone;
}

// create '_plots' object grouping x/y axes into subplots
// to be better manage subplots
function makeSubplots(gd, subplots) {
    var _plots = gd._fullLayout._plots = {};
    var subplot, plotinfo;

    function getAxisFunc(subplot, axLetter) {
        return function() {
            return Plotly.Axes.getFromId(gd, subplot, axLetter);
        };
    }

    for(var i = 0; i < subplots.length; i++) {
        subplot = subplots[i];
        plotinfo = _plots[subplot] = {};

        plotinfo.id = subplot;

        // references to the axis objects controlling this subplot
        plotinfo.x = getAxisFunc(subplot, 'x');
        plotinfo.y = getAxisFunc(subplot, 'y');

        // TODO investigate why replacing calls to .x and .y
        // for .xaxis and .yaxis makes the `pseudo_html`
        // test image fail
        plotinfo.xaxis = plotinfo.x();
        plotinfo.yaxis = plotinfo.y();
    }
}

function makeCartesianPlotFramwork(gd, subplots) {
    var fullLayout = gd._fullLayout;

    // Layers to keep plot types in the right order.
    // from back to front:
    // 1. heatmaps, 2D histos and contour maps
    // 2. bars / 1D histos
    // 3. errorbars for bars and scatter
    // 4. scatter
    // 5. box plots
    function plotLayers(svg) {
        svg.append('g').classed('imagelayer', true);
        svg.append('g').classed('maplayer', true);
        svg.append('g').classed('barlayer', true);
        svg.append('g').classed('boxlayer', true);
        svg.append('g').classed('scatterlayer', true);
    }

    // create all the layers in order, so we know they'll stay in order
    var overlays = [];

    fullLayout._paper.selectAll('g.subplot').data(subplots)
      .enter().append('g')
        .classed('subplot', true)
        .each(function(subplot) {
            var plotinfo = fullLayout._plots[subplot],
                plotgroup = plotinfo.plotgroup = d3.select(this).classed(subplot, true),
                xa = plotinfo.xaxis,
                ya = plotinfo.yaxis;

            // references to any subplots overlaid on this one
            plotinfo.overlays = [];

            // is this subplot overlaid on another?
            // ax.overlaying is the id of another axis of the same
            // dimension that this one overlays to be an overlaid subplot,
            // the main plot must exist make sure we're not trying to
            // overlay on an axis that's already overlaying another
            var xa2 = Plotly.Axes.getFromId(gd, xa.overlaying) || xa;
            if(xa2 !== xa && xa2.overlaying) {
                xa2 = xa;
                xa.overlaying = false;
            }

            var ya2 = Plotly.Axes.getFromId(gd, ya.overlaying) || ya;
            if(ya2 !== ya && ya2.overlaying) {
                ya2 = ya;
                ya.overlaying = false;
            }

            var mainplot = xa2._id + ya2._id;
            if(mainplot !== subplot && subplots.indexOf(mainplot) !== -1) {
                plotinfo.mainplot = mainplot;
                overlays.push(plotinfo);

                // for now force overlays to overlay completely... so they
                // can drag together correctly and share backgrounds.
                // Later perhaps we make separate axis domain and
                // tick/line domain or something, so they can still share
                // the (possibly larger) dragger and background but don't
                // have to both be drawn over that whole domain
                xa.domain = xa2.domain.slice();
                ya.domain = ya2.domain.slice();
            }
            else {
                // main subplot - make the components of
                // the plot and containers for overlays
                plotinfo.bg = plotgroup.append('rect')
                    .style('stroke-width', 0);

                // back layer for shapes and images to
                // be drawn below a subplot
                var backlayer = plotgroup.append('g')
                    .classed('layer-subplot', true);

                plotinfo.shapelayer = backlayer.append('g')
                    .classed('shapelayer', true);
                plotinfo.imagelayer = backlayer.append('g')
                    .classed('imagelayer', true);
                plotinfo.gridlayer = plotgroup.append('g');
                plotinfo.overgrid = plotgroup.append('g');
                plotinfo.zerolinelayer = plotgroup.append('g');
                plotinfo.overzero = plotgroup.append('g');
                plotinfo.plot = plotgroup.append('g').call(plotLayers);
                plotinfo.overplot = plotgroup.append('g');
                plotinfo.xlines = plotgroup.append('path');
                plotinfo.ylines = plotgroup.append('path');
                plotinfo.overlines = plotgroup.append('g');
                plotinfo.xaxislayer = plotgroup.append('g');
                plotinfo.yaxislayer = plotgroup.append('g');
                plotinfo.overaxes = plotgroup.append('g');

                // make separate drag layers for each subplot,
                // but append them to paper rather than the plot groups,
                // so they end up on top of the rest
            }
            plotinfo.draglayer = fullLayout._draggers.append('g');
        });

    // now make the components of overlaid subplots
    // overlays don't have backgrounds, and append all
    // their other components to the corresponding
    // extra groups of their main Plots.
    overlays.forEach(function(plotinfo) {
        var mainplot = fullLayout._plots[plotinfo.mainplot];
        mainplot.overlays.push(plotinfo);

        plotinfo.gridlayer = mainplot.overgrid.append('g');
        plotinfo.zerolinelayer = mainplot.overzero.append('g');
        plotinfo.plot = mainplot.overplot.append('g').call(plotLayers);
        plotinfo.xlines = mainplot.overlines.append('path');
        plotinfo.ylines = mainplot.overlines.append('path');
        plotinfo.xaxislayer = mainplot.overaxes.append('g');
        plotinfo.yaxislayer = mainplot.overaxes.append('g');
    });

    // common attributes for all subplots, overlays or not
    subplots.forEach(function(subplot) {
        var plotinfo = fullLayout._plots[subplot];

        plotinfo.xlines
            .style('fill', 'none')
            .classed('crisp', true);
        plotinfo.ylines
            .style('fill', 'none')
            .classed('crisp', true);
    });
}

// plot / update sub routines

// layoutStyles: styling for plot layout elements
function layoutStyles(gd) {
    return Lib.syncOrAsync([Plots.doAutoMargin, lsInner], gd);
}

function lsInner(gd) {
    var fullLayout = gd._fullLayout,
        gs = fullLayout._size,
        axList = Plotly.Axes.list(gd),
        i;

    // clear axis line positions, to be set in the subplot loop below
    for(i = 0; i < axList.length; i++) axList[i]._linepositions = {};

    fullLayout._paperdiv
        .style({
            width: fullLayout.width + 'px',
            height: fullLayout.height + 'px'
        })
        .selectAll('.main-svg')
            .call(Drawing.setSize, fullLayout.width, fullLayout.height);

    gd._context.setBackground(gd, fullLayout.paper_bgcolor);

    var freefinished = [];
    fullLayout._paper.selectAll('g.subplot').each(function(subplot) {
        var plotinfo = fullLayout._plots[subplot],
            xa = Plotly.Axes.getFromId(gd, subplot, 'x'),
            ya = Plotly.Axes.getFromId(gd, subplot, 'y');
        xa.setScale(); // this may already be done... not sure
        ya.setScale();

        if(plotinfo.bg) {
            plotinfo.bg
                .call(Drawing.setRect,
                    xa._offset - gs.p, ya._offset - gs.p,
                    xa._length + 2 * gs.p, ya._length + 2 * gs.p)
                .call(Color.fill, fullLayout.plot_bgcolor);
        }


        // Clip so that data only shows up on the plot area.
        plotinfo.clipId = 'clip' + fullLayout._uid + subplot + 'plot';

        var plotClip = fullLayout._defs.selectAll('g.clips')
            .selectAll('#' + plotinfo.clipId)
            .data([0]);

        plotClip.enter().append('clipPath')
            .attr({
                'class': 'plotclip',
                'id': plotinfo.clipId
            })
            .append('rect');

        plotClip.selectAll('rect')
            .attr({
                'width': xa._length,
                'height': ya._length
            });


        plotinfo.plot.call(Lib.setTranslate, xa._offset, ya._offset);
        plotinfo.plot.call(Drawing.setClipUrl, plotinfo.clipId);

        var xlw = Drawing.crispRound(gd, xa.linewidth, 1),
            ylw = Drawing.crispRound(gd, ya.linewidth, 1),
            xp = gs.p + ylw,
            xpathPrefix = 'M' + (-xp) + ',',
            xpathSuffix = 'h' + (xa._length + 2 * xp),
            showfreex = xa.anchor === 'free' &&
                freefinished.indexOf(xa._id) === -1,
            freeposx = gs.h * (1 - (xa.position||0)) + ((xlw / 2) % 1),
            showbottom =
                (xa.anchor === ya._id && (xa.mirror || xa.side !== 'top')) ||
                xa.mirror === 'all' || xa.mirror === 'allticks' ||
                (xa.mirrors && xa.mirrors[ya._id + 'bottom']),
            bottompos = ya._length + gs.p + xlw / 2,
            showtop =
                (xa.anchor === ya._id && (xa.mirror || xa.side === 'top')) ||
                xa.mirror === 'all' || xa.mirror === 'allticks' ||
                (xa.mirrors && xa.mirrors[ya._id + 'top']),
            toppos = -gs.p - xlw / 2,

            // shorten y axis lines so they don't overlap x axis lines
            yp = gs.p,
            // except where there's no x line
            // TODO: this gets more complicated with multiple x and y axes
            ypbottom = showbottom ? 0 : xlw,
            yptop = showtop ? 0 : xlw,
            ypathSuffix = ',' + (-yp - yptop) +
                'v' + (ya._length + 2 * yp + yptop + ypbottom),
            showfreey = ya.anchor === 'free' &&
                freefinished.indexOf(ya._id) === -1,
            freeposy = gs.w * (ya.position||0) + ((ylw / 2) % 1),
            showleft =
                (ya.anchor === xa._id && (ya.mirror || ya.side !== 'right')) ||
                ya.mirror === 'all' || ya.mirror === 'allticks' ||
                (ya.mirrors && ya.mirrors[xa._id + 'left']),
            leftpos = -gs.p - ylw / 2,
            showright =
                (ya.anchor === xa._id && (ya.mirror || ya.side === 'right')) ||
                ya.mirror === 'all' || ya.mirror === 'allticks' ||
                (ya.mirrors && ya.mirrors[xa._id + 'right']),
            rightpos = xa._length + gs.p + ylw / 2;

        // save axis line positions for ticks, draggers, etc to reference
        // each subplot gets an entry:
        //    [left or bottom, right or top, free, main]
        // main is the position at which to draw labels and draggers, if any
        xa._linepositions[subplot] = [
            showbottom ? bottompos : undefined,
            showtop ? toppos : undefined,
            showfreex ? freeposx : undefined
        ];
        if(xa.anchor === ya._id) {
            xa._linepositions[subplot][3] = xa.side === 'top' ?
                toppos : bottompos;
        }
        else if(showfreex) {
            xa._linepositions[subplot][3] = freeposx;
        }

        ya._linepositions[subplot] = [
            showleft ? leftpos : undefined,
            showright ? rightpos : undefined,
            showfreey ? freeposy : undefined
        ];
        if(ya.anchor === xa._id) {
            ya._linepositions[subplot][3] = ya.side === 'right' ?
                rightpos : leftpos;
        }
        else if(showfreey) {
            ya._linepositions[subplot][3] = freeposy;
        }

        // translate all the extra stuff to have the
        // same origin as the plot area or axes
        var origin = 'translate(' + xa._offset + ',' + ya._offset + ')',
            originx = origin,
            originy = origin;
        if(showfreex) {
            originx = 'translate(' + xa._offset + ',' + gs.t + ')';
            toppos += ya._offset - gs.t;
            bottompos += ya._offset - gs.t;
        }
        if(showfreey) {
            originy = 'translate(' + gs.l + ',' + ya._offset + ')';
            leftpos += xa._offset - gs.l;
            rightpos += xa._offset - gs.l;
        }

        plotinfo.xlines
            .attr('transform', originx)
            .attr('d', (
                (showbottom ? (xpathPrefix + bottompos + xpathSuffix) : '') +
                (showtop ? (xpathPrefix + toppos + xpathSuffix) : '') +
                (showfreex ? (xpathPrefix + freeposx + xpathSuffix) : '')) ||
                // so it doesn't barf with no lines shown
                'M0,0')
            .style('stroke-width', xlw + 'px')
            .call(Color.stroke, xa.showline ?
                xa.linecolor : 'rgba(0,0,0,0)');
        plotinfo.ylines
            .attr('transform', originy)
            .attr('d', (
                (showleft ? ('M' + leftpos + ypathSuffix) : '') +
                (showright ? ('M' + rightpos + ypathSuffix) : '') +
                (showfreey ? ('M' + freeposy + ypathSuffix) : '')) ||
                'M0,0')
            .attr('stroke-width', ylw + 'px')
            .call(Color.stroke, ya.showline ?
                ya.linecolor : 'rgba(0,0,0,0)');

        plotinfo.xaxislayer.attr('transform', originx);
        plotinfo.yaxislayer.attr('transform', originy);
        plotinfo.gridlayer.attr('transform', origin);
        plotinfo.zerolinelayer.attr('transform', origin);
        plotinfo.draglayer.attr('transform', origin);

        // mark free axes as displayed, so we don't draw them again
        if(showfreex) { freefinished.push(xa._id); }
        if(showfreey) { freefinished.push(ya._id); }
    });

    Plotly.Axes.makeClipPaths(gd);

    drawMainTitle(gd);

    ModeBar.manage(gd);

    return gd._promises.length && Promise.all(gd._promises);
}

function drawMainTitle(gd) {
    var fullLayout = gd._fullLayout;

    Titles.draw(gd, 'gtitle', {
        propContainer: fullLayout,
        propName: 'title',
        dfltName: 'Plot',
        attributes: {
            x: fullLayout.width / 2,
            y: fullLayout._size.t / 2,
            'text-anchor': 'middle'
        }
    });
}

// First, see if we need to do arraysToCalcdata
// call it regardless of what change we made, in case
// supplyDefaults brought in an array that was already
// in gd.data but not in gd._fullData previously
function doTraceStyle(gd) {
    for(var i = 0; i < gd.calcdata.length; i++) {
        var cdi = gd.calcdata[i],
            _module = ((cdi[0] || {}).trace || {})._module || {},
            arraysToCalcdata = _module.arraysToCalcdata;

        if(arraysToCalcdata) arraysToCalcdata(cdi);
    }

    Plots.style(gd);
    Registry.getComponentMethod('legend', 'draw')(gd);

    return Plots.previousPromises(gd);
}

function doColorBars(gd) {
    for(var i = 0; i < gd.calcdata.length; i++) {
        var cdi0 = gd.calcdata[i][0];

        if((cdi0.t || {}).cb) {
            var trace = cdi0.trace,
                cb = cdi0.t.cb;

            if(Registry.traceIs(trace, 'contour')) {
                cb.line({
                    width: trace.contours.showlines !== false ?
                        trace.line.width : 0,
                    dash: trace.line.dash,
                    color: trace.contours.coloring === 'line' ?
                        cb._opts.line.color : trace.line.color
                });
            }
            if(Registry.traceIs(trace, 'markerColorscale')) {
                cb.options(trace.marker.colorbar)();
            }
            else cb.options(trace.colorbar)();
        }
    }

    return Plots.previousPromises(gd);
}

// force plot() to redo the layout and replot with the modified layout
function layoutReplot(gd) {
    gd.layout = undefined;
    return Plotly.plot(gd, '', gd.layout);
}

function doLegend(gd) {
    Registry.getComponentMethod('legend', 'draw')(gd);
    return Plots.previousPromises(gd);
}

function doTicksRelayout(gd) {
    Plotly.Axes.doTicks(gd, 'redraw');
    drawMainTitle(gd);
    return Plots.previousPromises(gd);
}

function doModeBar(gd) {
    var fullLayout = gd._fullLayout;
    var subplotIds, i;

    ModeBar.manage(gd);
    Plotly.Fx.supplyLayoutDefaults(gd.layout, gd._fullLayout, gd._fullData);
    Plotly.Fx.init(gd);

    subplotIds = Plots.getSubplotIds(fullLayout, 'gl3d');
    for(i = 0; i < subplotIds.length; i++) {
        var scene = fullLayout[subplotIds[i]]._scene;
        scene.updateFx(fullLayout.dragmode, fullLayout.hovermode);
    }

    subplotIds = Plots.getSubplotIds(fullLayout, 'gl2d');
    for(i = 0; i < subplotIds.length; i++) {
        var scene2d = fullLayout._plots[subplotIds[i]]._scene2d;
        scene2d.updateFx(fullLayout);
    }

    subplotIds = Plots.getSubplotIds(fullLayout, 'geo');
    for(i = 0; i < subplotIds.length; i++) {
        var geo = fullLayout[subplotIds[i]]._geo;
        geo.updateFx(fullLayout.hovermode);
    }

    return Plots.previousPromises(gd);
}

function setRangeSliderRange(gd, changes) {
    var fullLayout = gd._fullLayout;

    var newMin = changes['xaxis.range'] ? changes['xaxis.range'][0] : changes['xaxis.range[0]'],
        newMax = changes['xaxis.range'] ? changes['xaxis.range'][1] : changes['xaxis.range[1]'];

    var rangeSlider = fullLayout.xaxis && fullLayout.xaxis.rangeslider ?
        fullLayout.xaxis.rangeslider : {};

    if(rangeSlider.visible) {
        if(newMin || newMax) {
            fullLayout.xaxis.rangeslider.setRange(newMin, newMax);
        }
        else if(changes['xaxis.autorange']) {
            fullLayout.xaxis.rangeslider.setRange();
        }
    }
}
