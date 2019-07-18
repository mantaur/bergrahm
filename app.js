"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var City = /** @class */ (function () {
    function City(point, name) {
        this.point = point;
        this.name = name;
    }
    Object.defineProperty(City.prototype, "id", {
        get: function () {
            return this.name;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(City.prototype, "PointX", {
        get: function () {
            return this.point.x;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(City.prototype, "PointY", {
        get: function () {
            return this.point.y;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(City.prototype, "Point", {
        get: function () {
            return this.point;
        },
        enumerable: true,
        configurable: true
    });
    return City;
}());
var CheckPoint = /** @class */ (function (_super) {
    __extends(CheckPoint, _super);
    function CheckPoint(point, name, Lastdistance) {
        var _this = _super.call(this, point, name) || this;
        _this.lastdist = Lastdistance;
        return _this;
    }
    return CheckPoint;
}(City));
var Path = /** @class */ (function () {
    function Path() {
        this._cities = [];
        this._nrOfCities = 0;
        this._individualFitness = 0;
    }
    Path.prototype.addCity = function (oneCity) {
        this._cities.push(oneCity);
        this._nrOfCities = this._nrOfCities + 1;
    };
    Path.prototype.altAddCity = function (oneCity) {
        this._cities.unshift(oneCity);
        this._nrOfCities = this._nrOfCities + 1;
    };
    Path.prototype.addCities = function (Cities) {
        this._nrOfCities = this._nrOfCities + Cities.length;
        this._cities = Cities.slice(0);
    };
    Path.prototype.addStart = function (oneCity) {
        this._cities.unshift(oneCity);
        this._nrOfCities = this._nrOfCities + 1;
    };
    Object.defineProperty(Path.prototype, "inside", {
        get: function () {
            return this._nrOfCities;
            //or: return this._cities.length;
        },
        enumerable: true,
        configurable: true
    });
    Path.prototype.tunnel = function (i) {
        return this._cities[i].id;
    };
    Object.defineProperty(Path.prototype, "individualFitness", {
        get: function () {
            var tempDis = 0;
            for (var i = 0; i <= this._nrOfCities; i++) {
                if (i < 1) {
                    tempDis = 0;
                }
                else if (i < this._nrOfCities) {
                    tempDis = tempDis + Math.sqrt(Math.pow(this._cities[i].PointX - this._cities[i - 1].PointX, 2) + Math.pow(this._cities[i].PointY - this._cities[i - 1].PointY, 2));
                }
                else {
                    tempDis = tempDis + Math.sqrt(Math.pow(this._cities[i - 1].PointX - this._cities[0].PointX, 2) + Math.pow(this._cities[i - 1].PointY - this._cities[0].PointY, 2));
                }
            }
            this._individualFitness = tempDis;
            return this._individualFitness;
        },
        enumerable: true,
        configurable: true
    });
    Path.prototype.shuffleArray = function () {
        var m = this._cities.length, t, i;
        while (m) {
            i = Math.floor(Math.random() * m--);
            t = this._cities[m];
            this._cities[m] = this._cities[i];
            this._cities[i] = t;
        }
    };
    Object.defineProperty(Path.prototype, "cities", {
        get: function () {
            return this._cities;
        },
        enumerable: true,
        configurable: true
    });
    Path.prototype.gBreed = function (parent) {
        this.rHalfP(parent);
        this.onlyUnique();
        return this;
    };
    Path.prototype.rHalfP = function (halfPath) {
        for (var i = Math.floor(halfPath._nrOfCities / 2); i >= 0; i--) {
            var r = Math.floor(Math.random() * i);
            this.altAddCity(halfPath._cities[i]);
        }
        return this;
    };
    Path.prototype.breed = function (parent) {
        this.halfP(parent);
        this.onlyUnique();
        return this;
    };
    Path.prototype.altBreed = function (parent) {
        this.altHalfP(parent);
        this.onlyUnique();
        return this;
    };
    Path.prototype.halfP = function (halfPath) {
        for (var i = Math.floor(halfPath._nrOfCities / 2); i >= 0; i--) {
            this.altAddCity(halfPath._cities[i]);
        }
        return this;
    };
    Path.prototype.altHalfP = function (halfPath) {
        for (var i = Math.floor(halfPath._nrOfCities / 2); i >= 0; i++) {
            this.addCity(halfPath._cities[i]);
        }
        return this;
    };
    Path.prototype.onlyUnique = function () {
        this._cities = this._cities.filter(function (v, index, self) { return index === self.findIndex(function (t) { return (t.Point === v.Point && t.name === v.id); }); });
        this._nrOfCities = this._cities.length;
        return this;
    };
    Path.prototype.join = function (secondP) {
        this._cities = this._cities.concat(secondP._cities);
    };
    return Path;
}());
var Population = /** @class */ (function () {
    function Population() {
        this._paths = [];
        this._nrOfPaths = 0;
        this._populationFitness = 0;
        this._lastGenFitness = 0;
        this._generation = 1;
    }
    Population.prototype.addPath = function (onePath) {
        this._paths.push(onePath);
        this._nrOfPaths = this._nrOfPaths + 1;
    };
    Population.prototype.sortAscending = function () {
        this._paths.sort(function (a, b) { return Number(a.individualFitness) - Number(b.individualFitness); });
    };
    Population.prototype.fitnessCheck = function () {
        this.sortAscending();
        var tempDis = 0;
        for (var i = 0; i < this._nrOfPaths; i++) {
            tempDis = tempDis + this._paths[i].individualFitness;
        }
        console.log("Total fitness: " + Math.round(tempDis));
        this._populationFitness = tempDis;
        console.log("Last gen fitness: " + Math.round(this._lastGenFitness));
        console.log("Avg individual fitness: " + Math.round(tempDis / this._nrOfPaths));
        this.sortAscending();
        this.bestFit();
        this._lastGenFitness = this._populationFitness;
    };
    Population.prototype.bestFit = function () {
        console.log("Most fit individual: " + Math.round(this._paths[0].individualFitness));
    };
    // Mutate function: Math.floor(Math.random() * 10 * ((((Math.pow(i,2)) / (Math.pow(i - 4000, 2))) / (0.002 * i)) / 3)-0.1) MUST be remade for 
    // population size other than 3333 (I think...), however a scalable function would be:
    // f(x) = ((3 * x) / 3333 ) - 2, which can be written as (x/1111) - 2, when done scalably this looks like: (x/(pop.size/3))-2,
    // or yet another alternative function is: g(x) = Math.pow(f(x), 2)
    Population.prototype.mutate = function () {
        var nrOfMutations = 0;
        for (var i = (this._nrOfPaths * (2 / 3)); i < (this._nrOfPaths); i++) {
            var adaptiveChanceFunc = (i / (this._nrOfPaths / 3)) - 2;
            var mutChance = adaptiveChanceFunc + Math.random();
            if (mutChance > 1) {
                this._paths[i].shuffleArray();
                nrOfMutations++;
            }
        }
        console.log(nrOfMutations + " mutations took place");
        console.log((nrOfMutations / (this._nrOfPaths / 3)) * 100 + "% of weakest third quartile was mutated");
    };
    Population.prototype.evolve = function (generations) {
        ctx.beginPath();
        ctx.moveTo(0, c.height);
        console.log("Starting evolution, evolving: " + generations + " times");
        var initDis = 0;
        for (var i = 0; i < this._nrOfPaths; i++) {
            initDis = initDis + this._paths[i].individualFitness;
        }
        this._populationFitness = initDis;
        var FGF = this._populationFitness;
        this.sortAscending();
        var FGMF = this._paths[0].individualFitness;
        for (var i = 0; i < generations; i++) {
            console.log("Generation: " + i);
            document.getElementById("generation").innerHTML = i.toString();
            // document.getElementById("currentFitness")!.innerHTML = this._paths[0].individualFitness.toString();
            this.sortAscending();
            this.drawNext(generations, i, this._paths[0], FGMF);
            this.mutate();
            //var m = (this._nrOfPaths/3), t, e;
            for (var jm = 0; jm < (this._nrOfPaths / 3); jm++) {
                //jm = counter j - Mother
                //jf = counter j - Father
                //jc = counter j - Child
                var jf = jm + (this._nrOfPaths / 3);
                var jc = jm + 2 * (this._nrOfPaths / 3);
                var parent1 = this._paths[jm].cities;
                var parent2 = this._paths[jf].cities;
                var middleMan1 = new Path;
                var middleMan2 = new Path;
                middleMan1.addCities(parent1);
                middleMan2.addCities(parent2);
                // let newMember: Path = middleMan1.halfP(middleMan2);
                // newMember.onlyUnique();
                if (i % 2) {
                    var newMember = middleMan1.gBreed(middleMan2);
                    this._paths[jc] = newMember;
                }
                else {
                    var newMember = middleMan2.gBreed(middleMan1);
                    this._paths[jc] = newMember;
                }
            }
            this.fitnessCheck();
        }
        console.log("First gen fitness: " + Math.round(FGF));
        console.log("Final gen fitness: " + Math.round(this._populationFitness));
        console.log("First gen most fit: " + Math.round(FGMF));
        console.log("Final gen most fit: " + Math.round(this._paths[0].individualFitness));
        var LGMF = this._paths[0].individualFitness;
        document.getElementById("startingFitness").innerHTML = FGMF.toString();
        document.getElementById("lastFitness").innerHTML = LGMF.toString();
    };
    Population.prototype.check = function (nrToCheck) {
        for (var i = 0; i < nrToCheck; i++) {
            var printArr = [];
            for (var j = 0; j < this._paths[i].inside; j++) {
                printArr[j] = this._paths[i].tunnel(j);
            }
            console.log("Individual: " + i + " " + printArr.join(" - "));
            console.log("Fitness: " + this._paths[i].individualFitness);
        }
    };
    Population.prototype.drawNext = function (nrGens, whatGen, ind, firstFit) {
        var x = (c.width / nrGens) * whatGen;
        var y = ((0.9 * c.height) / firstFit) * ind.individualFitness;
        ctx.lineTo(x, y);
        ctx.stroke();
    };
    ;
    return Population;
}());
var App = /** @class */ (function () {
    function App() {
    }
    App.prototype.start = function () {
        console.log("Starting application...");
        console.log("Clearing Canvas");
        this.clear(c, ctx);
        var num = -2;
        var result = num > 0 ? "positive" : "non-positive";
        console.log(result);
        var allCities = [];
        var nrOfCities = parseFloat(nrC.value) || 10;
        var nrOfPaths = parseFloat(nrP.value) || 3333;
        var nrOfGenerations = parseFloat(nrG.value) || 4;
        console.log("Creating " + nrOfCities + " Cities...");
        for (var i_1 = 0; i_1 < nrOfCities; i_1++) {
            var j_1 = i_1 + 1;
            allCities[i_1] = new City({ x: ((50 / Math.PI) * Math.cos(i_1 * (2 * Math.PI) / (nrOfCities))), y: ((50 / Math.PI) * Math.sin(i_1 * (2 * Math.PI) / (nrOfCities))) }, "C" + j_1);
            console.log("  City nr " + i_1 + " " + allCities[i_1].id + ": " + allCities[i_1].PointX + "," + allCities[i_1].PointY);
        }
        ;
        var myPopulation = new Population();
        console.log("Creating Population of size: " + nrOfPaths);
        for (var i = 0; i < nrOfPaths; i++) {
            var tempArr = allCities.slice(0);
            var myPath = new Path();
            for (var j = 0; j < nrOfCities; j++) {
                if (j < nrOfCities - 1) {
                    var spliceValue = Math.random() * (tempArr.length - 1);
                    var tempAdd = tempArr.splice(Math.ceil(Math.floor(spliceValue) + 0.1), 1);
                    myPath.addCity(tempAdd[0]);
                    // console.log(myPath.)                
                }
                else {
                    var tempAdd = tempArr.splice(0, 1);
                    myPath.addStart(tempAdd[0]);
                }
            }
            myPopulation.addPath(myPath);
        }
        ;
        myPopulation.evolve(nrOfGenerations);
        // ctx.stroke();
        myPopulation.check(1);
    };
    ;
    App.prototype.clear = function (canvas, context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        console.log("Cleared canvas");
    };
    ;
    return App;
}());
var app = new App();
function bStart() {
    app.start();
}
function bClear() {
    ctx.clearRect(0, 0, c.width, c.height);
    console.log("Cleared Canvas");
}
;
var nrC = document.getElementById('nrCities');
var nrP = document.getElementById('nrPaths');
var nrG = document.getElementById('nrGenerations');
var c = document.getElementById("myCanvas");
var ctx = c.getContext("2d");
// ctx.translate(c.width, c.height)
c.width = window.innerWidth / 2.2;
c.height = window.innerHeight / 3;
//Usefull for learning 'requestAnimationFrame': https://theblogofpeterchen.blogspot.com/2015/02/html5-high-performance-real-time.html
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2FwcC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7OztBQUtBO0lBR0ksY0FBWSxLQUFhLEVBQUUsSUFBYTtRQUNwQyxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztJQUNyQixDQUFDO0lBQ0Qsc0JBQUksb0JBQUU7YUFBTjtZQUNJLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQztRQUNyQixDQUFDOzs7T0FBQTtJQUNELHNCQUFJLHdCQUFNO2FBQVY7WUFDSSxPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3hCLENBQUM7OztPQUFBO0lBQ0Qsc0JBQUksd0JBQU07YUFBVjtZQUNJLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDeEIsQ0FBQzs7O09BQUE7SUFDRCxzQkFBSSx1QkFBSzthQUFUO1lBQ0ksT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFBO1FBQ3JCLENBQUM7OztPQUFBO0lBRUwsV0FBQztBQUFELENBQUMsQUFwQkQsSUFvQkM7QUFFRDtJQUF5Qiw4QkFBSTtJQUV6QixvQkFBWSxLQUFhLEVBQUUsSUFBYSxFQUFFLFlBQW9CO1FBQTlELFlBQ0ksa0JBQU0sS0FBSyxFQUFFLElBQUksQ0FBQyxTQUVyQjtRQURHLEtBQUksQ0FBQyxRQUFRLEdBQUcsWUFBWSxDQUFDOztJQUNqQyxDQUFDO0lBQ0wsaUJBQUM7QUFBRCxDQUFDLEFBTkQsQ0FBeUIsSUFBSSxHQU01QjtBQUVEO0lBQUE7UUFDWSxZQUFPLEdBQVcsRUFBRSxDQUFDO1FBQ3JCLGdCQUFXLEdBQVcsQ0FBQyxDQUFDO1FBQ3hCLHVCQUFrQixHQUFXLENBQUMsQ0FBQztJQTRGM0MsQ0FBQztJQTNGRyxzQkFBTyxHQUFQLFVBQVEsT0FBYTtRQUNqQixJQUFJLENBQUMsT0FBTyxDQUFDLElB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LENBQUM7SUFDTixVQUFDO0FBQUQsQ0FBQyxBQW5ERCxJQW1EQztBQUNELElBQU0sR0FBRyxHQUFHLElBQUksR0FBRyxFQUFFLENBQUM7QUFDdEIsU0FBUyxNQUFNO0lBQ1gsR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFBO0FBQ2YsQ0FBQztBQUNELFNBQVMsTUFBTTtJQUNYLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN2QyxPQUFPLENBQUMsR0FBRyxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFDbEMsQ0FBQztBQUFBLENBQUM7QUFFRixJQUFJLEdBQUcsR0FBdUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxVQUFVLENBQUUsQ0FBQztBQUNuRixJQUFJLEdBQUcsR0FBdUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxTQUFTLENBQUUsQ0FBQztBQUNsRixJQUFJLEdBQUcsR0FBdUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxlQUFlLENBQUUsQ0FBQztBQUV4RixJQUFJLENBQUMsR0FBeUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxVQUFVLENBQUUsQ0FBQztBQUNuRixJQUFJLEdBQUcsR0FBRyxDQUFDLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBRSxDQUFDO0FBQzlCLG1DQUFtQztBQUVuQyxDQUFDLENBQUMsS0FBSyxHQUFHLE1BQU0sQ0FBQyxVQUFVLEdBQUMsR0FBRyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDLFdBQVcsR0FBQyxDQUFDLENBQUM7QUFFaEMscUlBQXFJIiwic291cmNlc0NvbnRlbnQiOlsiaW50ZXJmYWNlIFBvaW50IHtcclxuICAgIHggOiBudW1iZXI7XHJcbiAgICB5IDogbnVtYmVyO1xyXG59XHJcblxyXG5jbGFzcyBDaXR5IHtcclxuICAgIHByaXZhdGUgcG9pbnQ6IFBvaW50O1xyXG4gICAgcHJpdmF0ZSBuYW1lOiBzdHJpbmc7XHJcbiAgICBjb25zdHJ1Y3Rvcihwb2ludCA6IFBvaW50LCBuYW1lIDogc3RyaW5nKSB7XHJcbiAgICAgICAgdGhpcy5wb2ludCA9IHBvaW50O1xyXG4gICAgICAgIHRoaXMubmFtZSA9IG5hbWU7XHJcbiAgICB9XHJcbiAgICBnZXQgaWQoKXtcclxuICAgICAgICByZXR1cm4gdGhpcy5uYW1lO1xyXG4gICAgfVxyXG4gICAgZ2V0IFBvaW50WCgpIDogbnVtYmVye1xyXG4gICAgICAgIHJldHVybiB0aGlzLnBvaW50Lng7XHJcbiAgICB9XHJcbiAgICBnZXQgUG9pbnRZKCkgOiBudW1iZXJ7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMucG9pbnQueTtcclxuICAgIH1cclxuICAgIGdldCBQb2ludCgpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5wb2ludFxyXG4gICAgfVxyXG4gICAgXHJcbn1cclxuXHJcbmNsYXNzIENoZWNrUG9pbnQgZXh0ZW5kcyBDaXR5IHtcclxuICAgIHByaXZhdGUgbGFzdGRpc3Q6IG51bWJlcjtcclxuICAgIGNvbnN0cnVjdG9yKHBvaW50IDogUG9pbnQsIG5hbWUgOiBzdHJpbmcsIExhc3RkaXN0YW5jZTogbnVtYmVyKSB7XHJcbiAgICAgICAgc3VwZXIocG9pbnQsIG5hbWUpOyAgICAgICAgXHJcbiAgICAgICAgdGhpcy5sYXN0ZGlzdCA9IExhc3RkaXN0YW5jZTtcclxuICAgIH1cclxufVxyXG5cclxuY2xhc3MgUGF0aCB7XHJcbiAgICBwcml2YXRlIF9jaXRpZXM6IENpdHlbXSA9IFtdO1xyXG4gICAgcHJpdmF0ZSBfbnJPZkNpdGllczogbnVtYmVyID0gMDtcclxuICAgIHByaXZhdGUgX2luZGl2aWR1YWxGaXRuZXNzOiBudW1iZXIgPSAwO1xyXG4gICAgYWRkQ2l0eShvbmVDaXR5OiBDaXR5KXtcclxuICAgICAgICB0aGlzLl9jaXRpZXMucHVzaChvbmVDaXR5KTtcclxuICAgICAgICB0aGlzLl9uck9mQ2l0aWVzID0gdGhpcy5fbnJPZkNpdGllcyArIDE7XHJcbiAgICB9XHJcbiAgICBhbHRBZGRDaXR5KG9uZUNpdHk6IENpdHkpe1xyXG4gICAgICAgIHRoaXMuX2NpdGllcy51bnNoaWZ0KG9uZUNpdHkpO1xyXG4gICAgICAgIHRoaXMuX25yT2ZDaXRpZXMgPSB0aGlzLl9uck9mQ2l0aWVzICsgMTtcclxuICAgIH1cclxuICAgIGFkZENpdGllcyhDaXRpZXM6IENpdHlbXSl7XHJcbiAgICAgICAgdGhpcy5fbnJPZkNpdGllcyA9IHRoaXMuX25yT2ZDaXRpZXMgKyBDaXRpZXMubGVuZ3RoO1xyXG4gICAgICAgIHRoaXMuX2NpdGllcyA9IENpdGllcy5zbGljZSgwKTtcclxuICAgIH1cclxuICAgIGFkZFN0YXJ0KG9uZUNpdHk6IENpdHkpe1xyXG4gICAgICAgIHRoaXMuX2NpdGllcy51bnNoaWZ0KG9uZUNpdHkpO1xyXG4gICAgICAgIHRoaXMuX25yT2ZDaXRpZXMgPSB0aGlzLl9uck9mQ2l0aWVzICsgMTtcclxuICAgIH1cclxuICAgIGdldCBpbnNpZGUoKXtcclxuICAgICAgICByZXR1cm4gdGhpcy5fbnJPZkNpdGllc1xyXG4gICAgICAgIC8vb3I6IHJldHVybiB0aGlzLl9jaXRpZXMubGVuZ3RoO1xyXG4gICAgfVxyXG4gICAgdHVubmVsKGk6bnVtYmVyKXtcclxuICAgICAgICByZXR1cm4gdGhpcy5fY2l0aWVzW2ldLmlkO1xyXG4gICAgfVxyXG4gICAgZ2V0IGluZGl2aWR1YWxGaXRuZXNzKCl7XHJcbiAgICAgICAgbGV0IHRlbXBEaXM6IG51bWJlciA9IDA7XHJcbiAgICAgICAgZm9yKHZhciBpID0gMDsgaSA8PSB0aGlzLl9uck9mQ2l0aWVzOyBpKyspe1xyXG4gICAgICAgICAgICBpZihpIDwgMSl7XHJcbiAgICAgICAgICAgICAgICB0ZW1wRGlzID0gMDtcclxuICAgICAgICAgICAgfSBlbHNlIGlmKGkgPCB0aGlzLl9uck9mQ2l0aWVzKXtcclxuICAgICAgICAgICAgICAgIHRlbXBEaXMgPSB0ZW1wRGlzICsgTWF0aC5zcXJ0KE1hdGgucG93KHRoaXMuX2NpdGllc1tpXS5Qb2ludFggLSB0aGlzLl9jaXRpZXNbaS0xXS5Qb2ludFgsIDIpICsgTWF0aC5wb3codGhpcy5fY2l0aWVzW2ldLlBvaW50WSAtIHRoaXMuX2NpdGllc1tpLTFdLlBvaW50WSwgMikpO1xyXG4gICAgICAgICAgICB9IGVsc2V7XHJcbiAgICAgICAgICAgICAgICB0ZW1wRGlzID0gdGVtcERpcyArIE1hdGguc3FydChNYXRoLnBvdyh0aGlzLl9jaXRpZXNbaS0xXS5Qb2ludFggLSB0aGlzLl9jaXRpZXNbMF0uUG9pbnRYLCAyKSArIE1hdGgucG93KHRoaXMuX2NpdGllc1tpLTFdLlBvaW50WSAtIHRoaXMuX2NpdGllc1swXS5Qb2ludFksIDIpKTtcclxuICAgICAgICAgICAgfSAgIFxyXG4gICAgICAgIH1cclxuICAgICAgICB0aGlzLl9pbmRpdmlkdWFsRml0bmVzcyA9IHRlbXBEaXM7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuX2luZGl2aWR1YWxGaXRuZXNzO1xyXG4gICAgfVxyXG4gICAgc2h1ZmZsZUFycmF5KCl7XHJcbiAgICAgICAgdmFyIG0gPSB0aGlzLl9jaXRpZXMubGVuZ3RoLCB0LCBpO1xyXG4gICAgICAgIHdoaWxlKG0pe1xyXG4gICAgICAgICAgICBpID0gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogbS0tKTtcclxuICAgICAgICAgICAgdCA9IHRoaXMuX2NpdGllc1ttXTtcclxuICAgICAgICAgICAgdGhpcy5fY2l0aWVzW21dID0gdGhpcy5fY2l0aWVzW2ldO1xyXG4gICAgICAgICAgICB0aGlzLl9jaXRpZXNbaV0gPSB0OyAgIFxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGdldCBjaXRpZXMoKXtcclxuICAgICAgICByZXR1cm4gdGhpcy5fY2l0aWVzXHJcbiAgICB9XHJcbiAgICBnQnJlZWQocGFyZW50OiBQYXRoKTogUGF0aHtcclxuICAgICAgICB0aGlzLnJIYWxmUChwYXJlbnQpO1xyXG4gICAgICAgIHRoaXMub25seVVuaXF1ZSgpO1xyXG4gICAgICAgIHJldHVybiB0aGlzO1xyXG4gICAgfVxyXG4gICAgckhhbGZQKGhhbGZQYXRoOiBQYXRoKTogUGF0aHtcclxuICAgICAgICBmb3IodmFyIGkgPSBNYXRoLmZsb29yKGhhbGZQYXRoLl9uck9mQ2l0aWVzLzIpOyBpPj0wOyBpLS0pe1xyXG4gICAgICAgICAgICBsZXQgciA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGkpO1xyXG4gICAgICAgICAgICB0aGlzLmFsdEFkZENpdHkoaGFsZlBhdGguX2NpdGllc1tpXSlcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRoaXM7XHJcbiAgICB9XHJcbiAgICBicmVlZChwYXJlbnQ6IFBhdGgpOiBQYXRoe1xyXG4gICAgICAgIHRoaXMuaGFsZlAocGFyZW50KTtcclxuICAgICAgICB0aGlzLm9ubHlVbmlxdWUoKTtcclxuICAgICAgICByZXR1cm4gdGhpcztcclxuICAgIH1cclxuICAgIGFsdEJyZWVkKHBhcmVudDogUGF0aCk6IFBhdGh7XHJcbiAgICAgICAgdGhpcy5hbHRIYWxmUChwYXJlbnQpO1xyXG4gICAgICAgIHRoaXMub25seVVuaXF1ZSgpXHJcbiAgICAgICAgcmV0dXJuIHRoaXM7XHJcbiAgICB9XHJcbiAgICBoYWxmUChoYWxmUGF0aDogUGF0aCl7XHJcbiAgICAgICAgZm9yKHZhciBpID0gTWF0aC5mbG9vcihoYWxmUGF0aC5fbnJPZkNpdGllcy8yKTsgaSA+PSAwOyBpLS0pe1xyXG4gICAgICAgICAgICB0aGlzLmFsdEFkZENpdHkoaGFsZlBhdGguX2NpdGllc1tpXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzO1xyXG4gICAgfVxyXG4gICAgYWx0SGFsZlAoaGFsZlBhdGg6IFBhdGgpe1xyXG4gICAgICAgIGZvcih2YXIgaSA9IE1hdGguZmxvb3IoaGFsZlBhdGguX25yT2ZDaXRpZXMvMik7IGkgPj0gMDsgaSsrKXtcclxuICAgICAgICAgICAgdGhpcy5hZGRDaXR5KGhhbGZQYXRoLl9jaXRpZXNbaV0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdGhpcztcclxuICAgIH1cclxuICAgIG9ubHlVbmlxdWUoKXsgXHJcbiAgICAgICAgdGhpcy5fY2l0aWVzID0gdGhpcy5fY2l0aWVzLmZpbHRlcigodiwgaW5kZXgsIHNlbGYpID0+ICBpbmRleCA9PT0gc2VsZi5maW5kSW5kZXgoKHQpID0+ICh0LlBvaW50ID09PSB2LlBvaW50ICYmIHQubmFtZSA9PT0gdi5pZCkpKVxyXG4gICAgICAgIHRoaXMuX25yT2ZDaXRpZXMgPSB0aGlzLl9jaXRpZXMubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB0aGlzO1xyXG4gICAgfVxyXG4gICAgam9pbihzZWNvbmRQOiBQYXRoKXtcclxuICAgICAgICB0aGlzLl9jaXRpZXMgPSB0aGlzLl9jaXRpZXMuY29uY2F0KHNlY29uZFAuX2NpdGllcylcclxuICAgIH1cclxufVxyXG5cclxuY2xhc3MgUG9wdWxhdGlvbiB7XHJcbiAgICBwcml2YXRlIF9wYXRoczogUGF0aFtdID0gW107XHJcbiAgICBwcml2YXRlIF9uck9mUGF0aHM6IG51bWJlciA9IDA7XHJcbiAgICBwcml2YXRlIF9wb3B1bGF0aW9uRml0bmVzczogbnVtYmVyID0gMDtcclxuICAgIHByaXZhdGUgX2xhc3RHZW5GaXRuZXNzOiBudW1iZXIgPSAwO1xyXG4gICAgcHJpdmF0ZSBfZ2VuZXJhdGlvbjogbnVtYmVyID0gMTtcclxuICAgIGFkZFBhdGgob25lUGF0aDogUGF0aCl7XHJcbiAgICAgICAgdGhpcy5fcGF0aHMucHVzaChvbmVQYXRoKVxyXG4gICAgICAgIHRoaXMuX25yT2ZQYXRocyA9IHRoaXMuX25yT2ZQYXRocyArIDE7XHJcbiAgICB9XHJcbiAgICBzb3J0QXNjZW5kaW5nKCk6IHZvaWR7XHJcbiAgICAgICAgdGhpcy5fcGF0aHMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGEuaW5kaXZpZHVhbEZpdG5lc3MpIC0gTnVtYmVyKGIuaW5kaXZpZHVhbEZpdG5lc3MpKTtcclxuICAgIH1cclxuICAgIGZpdG5lc3NDaGVjaygpOiB2b2lke1xyXG4gICAgICAgIHRoaXMuc29ydEFzY2VuZGluZygpO1xyXG4gICAgICAgIGxldCB0ZW1wRGlzOiBudW1iZXIgPSAwO1xyXG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCB0aGlzLl9uck9mUGF0aHM7IGkrKyl7XHJcbiAgICAgICAgICAgIHRlbXBEaXMgPSB0ZW1wRGlzICsgdGhpcy5fcGF0aHNbaV0uaW5kaXZpZHVhbEZpdG5lc3NcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJUb3RhbCBmaXRuZXNzOiBcIiArIE1hdGgucm91bmQodGVtcERpcykpO1xyXG4gICAgICAgIHRoaXMuX3BvcHVsYXRpb25GaXRuZXNzID0gdGVtcERpcztcclxuICAgICAgICBjb25zb2xlLmxvZyhcIkxhc3QgZ2VuIGZpdG5lc3M6IFwiICsgTWF0aC5yb3VuZCh0aGlzLl9sYXN0R2VuRml0bmVzcykpO1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFwiQXZnIGluZGl2aWR1YWwgZml0bmVzczogXCIgKyBNYXRoLnJvdW5kKHRlbXBEaXMvdGhpcy5fbnJPZlBhdGhzKSk7XHJcbiAgICAgICAgdGhpcy5zb3J0QXNjZW5kaW5nKCk7XHJcbiAgICAgICAgdGhpcy5iZXN0Rml0KCk7XHJcbiAgICAgICAgdGhpcy5fbGFzdEdlbkZpdG5lc3MgPSB0aGlzLl9wb3B1bGF0aW9uRml0bmVzcztcclxuICAgIH1cclxuICAgIGJlc3RGaXQoKTogdm9pZHtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIk1vc3QgZml0IGluZGl2aWR1YWw6IFwiICsgTWF0aC5yb3VuZCh0aGlzLl9wYXRoc1swXS5pbmRpdmlkdWFsRml0bmVzcykpO1xyXG4gICAgfVxyXG4gICAgLy8gTXV0YXRlIGZ1bmN0aW9uOiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAxMCAqICgoKChNYXRoLnBvdyhpLDIpKSAvIChNYXRoLnBvdyhpIC0gNDAwMCwgMikpKSAvICgwLjAwMiAqIGkpKSAvIDMpLTAuMSkgTVVTVCBiZSByZW1hZGUgZm9yIFxyXG4gICAgLy8gcG9wdWxhdGlvbiBzaXplIG90aGVyIHRoYW4gMzMzMyAoSSB0aGluay4uLiksIGhvd2V2ZXIgYSBzY2FsYWJsZSBmdW5jdGlvbiB3b3VsZCBiZTpcclxuICAgIC8vIGYoeCkgPSAoKDMgKiB4KSAvIDMzMzMgKSAtIDIsIHdoaWNoIGNhbiBiZSB3cml0dGVuIGFzICh4LzExMTEpIC0gMiwgd2hlbiBkb25lIHNjYWxhYmx5IHRoaXMgbG9va3MgbGlrZTogKHgvKHBvcC5zaXplLzMpKS0yLFxyXG4gICAgLy8gb3IgeWV0IGFub3RoZXIgYWx0ZXJuYXRpdmUgZnVuY3Rpb24gaXM6IGcoeCkgPSBNYXRoLnBvdyhmKHgpLCAyKVxyXG4gICAgbXV0YXRlKCkge1xyXG4gICAgICAgIGxldCBuck9mTXV0YXRpb25zOiBudW1iZXIgPSAwOyBcclxuICAgICAgICBmb3IobGV0IGkgPSAodGhpcy5fbnJPZlBhdGhzICogKDIvMykpOyBpIDwgKHRoaXMuX25yT2ZQYXRocyk7IGkrKyl7XHJcbiAgICAgICAgICAgIGxldCBhZGFwdGl2ZUNoYW5jZUZ1bmMgPSAoaS8odGhpcy5fbnJPZlBhdGhzLzMpKS0yO1xyXG4gICAgICAgICAgICBsZXQgbXV0Q2hhbmNlID0gYWRhcHRpdmVDaGFuY2VGdW5jICsgTWF0aC5yYW5kb20oKTtcclxuICAgICAgICAgICAgaWYobXV0Q2hhbmNlID4gMSl7XHJcbiAgICAgICAgICAgICAgICB0aGlzLl9wYXRoc1tpXS5zaHVmZmxlQXJyYXkoKTtcclxuICAgICAgICAgICAgICAgIG5yT2ZNdXRhdGlvbnMrKztcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zb2xlLmxvZyhuck9mTXV0YXRpb25zICsgXCIgbXV0YXRpb25zIHRvb2sgcGxhY2VcIik7XHJcbiAgICAgICAgY29uc29sZS5sb2coKG5yT2ZNdXRhdGlvbnMvKHRoaXMuX25yT2ZQYXRocy8zKSkgKiAxMDAgKyBcIiUgb2Ygd2Vha2VzdCB0aGlyZCBxdWFydGlsZSB3YXMgbXV0YXRlZFwiKTtcclxuICAgIH1cclxuICAgIGV2b2x2ZShnZW5lcmF0aW9uczogbnVtYmVyKTogdm9pZHtcclxuICAgICAgICBjdHguYmVnaW5QYXRoKCk7XHJcbiAgICAgICAgY3R4Lm1vdmVUbygwLGMuaGVpZ2h0KTtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIlN0YXJ0aW5nIGV2b2x1dGlvbiwgZXZvbHZpbmc6IFwiICsgZ2VuZXJhdGlvbnMgKyBcIiB0aW1lc1wiKTtcclxuICAgICAgICBsZXQgaW5pdERpczogbnVtYmVyID0gMFxyXG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCB0aGlzLl9uck9mUGF0aHM7IGkrKyl7XHJcbiAgICAgICAgICAgIGluaXREaXMgPSBpbml0RGlzICsgdGhpcy5fcGF0aHNbaV0uaW5kaXZpZHVhbEZpdG5lc3NcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy5fcG9wdWxhdGlvbkZpdG5lc3MgPSBpbml0RGlzO1xyXG4gICAgICAgIGxldCBGR0YgPSB0aGlzLl9wb3B1bGF0aW9uRml0bmVzcztcclxuICAgICAgICB0aGlzLnNvcnRBc2NlbmRpbmcoKTtcclxuICAgICAgICBsZXQgRkdNRiA9IHRoaXMuX3BhdGhzWzBdLmluZGl2aWR1YWxGaXRuZXNzO1xyXG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCBnZW5lcmF0aW9uczsgaSsrKXtcclxuICAgICAgICAgICAgY29uc29sZS5sb2coXCJHZW5lcmF0aW9uOiBcIiArIGkpO1xyXG4gICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImdlbmVyYXRpb25cIikhLmlubmVySFRNTCA9IGkudG9TdHJpbmcoKTtcclxuICAgICAgICAgICAgLy8gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjdXJyZW50Rml0bmVzc1wiKSEuaW5uZXJIVE1MID0gdGhpcy5fcGF0aHNbMF0uaW5kaXZpZHVhbEZpdG5lc3MudG9TdHJpbmcoKTtcclxuICAgICAgICAgICAgdGhpcy5zb3J0QXNjZW5kaW5nKCk7XHJcbiAgICAgICAgICAgIHRoaXMuZHJhd05leHQoZ2VuZXJhdGlvbnMsIGksIHRoaXMuX3BhdGhzWzBdLCBGR01GKTtcclxuICAgICAgICAgICAgdGhpcy5tdXRhdGUoKTtcclxuICAgICAgICAgICAgLy92YXIgbSA9ICh0aGlzLl9uck9mUGF0aHMvMyksIHQsIGU7XHJcbiAgICAgICAgICAgIGZvcih2YXIgam0gPSAwOyBqbSA8ICh0aGlzLl9uck9mUGF0aHMvMyk7IGptKyspeyBcclxuICAgICAgICAgICAgICAgIC8vam0gPSBjb3VudGVyIGogLSBNb3RoZXJcclxuICAgICAgICAgICAgICAgIC8vamYgPSBjb3VudGVyIGogLSBGYXRoZXJcclxuICAgICAgICAgICAgICAgIC8vamMgPSBjb3VudGVyIGogLSBDaGlsZFxyXG4gICAgICAgICAgICAgICAgbGV0IGpmOiBudW1iZXIgPSBqbSArICh0aGlzLl9uck9mUGF0aHMvMyk7XHJcbiAgICAgICAgICAgICAgICBsZXQgamM6IG51bWJlciA9IGptICsgMioodGhpcy5fbnJPZlBhdGhzLzMpO1xyXG5cclxuICAgICAgICAgICAgICAgIGxldCBwYXJlbnQxOiBDaXR5W10gPSB0aGlzLl9wYXRoc1tqbV0uY2l0aWVzO1xyXG4gICAgICAgICAgICAgICAgbGV0IHBhcmVudDI6IENpdHlbXSA9IHRoaXMuX3BhdGhzW2pmXS5jaXRpZXM7XHJcbiAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgIGxldCBtaWRkbGVNYW4xOiBQYXRoID0gbmV3IFBhdGg7XHJcbiAgICAgICAgICAgICAgICBsZXQgbWlkZGxlTWFuMjogUGF0aCA9IG5ldyBQYXRoXHJcbiAgICAgICAgICAgICAgICBtaWRkbGVNYW4xLmFkZENpdGllcyhwYXJlbnQxKVxyXG4gICAgICAgICAgICAgICAgbWlkZGxlTWFuMi5hZGRDaXRpZXMocGFyZW50MilcclxuXHJcbiAgICAgICAgICAgICAgICAvLyBsZXQgbmV3TWVtYmVyOiBQYXRoID0gbWlkZGxlTWFuMS5oYWxmUChtaWRkbGVNYW4yKTtcclxuICAgICAgICAgICAgICAgIC8vIG5ld01lbWJlci5vbmx5VW5pcXVlKCk7XHJcbiAgICAgICAgICAgICAgICBpZihpICUgMil7XHJcbiAgICAgICAgICAgICAgICAgICAgbGV0IG5ld01lbWJlcjogUGF0aCA9IG1pZGRsZU1hbjEuZ0JyZWVkKG1pZGRsZU1hbjIpO1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3BhdGhzW2pjXSA9IG5ld01lbWJlcjtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgbGV0IG5ld01lbWJlcjogUGF0aCA9IG1pZGRsZU1hbjIuZ0JyZWVkKG1pZGRsZU1hbjEpXHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcGF0aHNbamNdID0gbmV3TWVtYmVyO1xyXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGhpcy5maXRuZXNzQ2hlY2soKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJGaXJzdCBnZW4gZml0bmVzczogXCIgKyBNYXRoLnJvdW5kKEZHRikpXHJcbiAgICAgICAgY29uc29sZS5sb2coXCJGaW5hbCBnZW4gZml0bmVzczogXCIgKyBNYXRoLnJvdW5kKHRoaXMuX3BvcHVsYXRpb25GaXRuZXNzKSlcclxuICAgICAgICBjb25zb2xlLmxvZyhcIkZpcnN0IGdlbiBtb3N0IGZpdDogXCIgKyBNYXRoLnJvdW5kIChGR01GKSlcclxuICAgICAgICBjb25zb2xlLmxvZyhcIkZpbmFsIGdlbiBtb3N0IGZpdDogXCIgKyBNYXRoLnJvdW5kKHRoaXMuX3BhdGhzWzBdLmluZGl2aWR1YWxGaXRuZXNzKSlcclxuICAgICAgICBsZXQgTEdNRiA9IHRoaXMuX3BhdGhzWzBdLmluZGl2aWR1YWxGaXRuZXNzO1xyXG4gICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic3RhcnRpbmdGaXRuZXNzXCIpIS5pbm5lckhUTUwgPSBGR01GLnRvU3RyaW5nKCk7XHJcbiAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsYXN0Rml0bmVzc1wiKSEuaW5uZXJIVE1MID0gTEdNRi50b1N0cmluZygpO1xyXG4gICAgfVxyXG4gICAgY2hlY2sobnJUb0NoZWNrOiBudW1iZXIpOiB2b2lke1xyXG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCBuclRvQ2hlY2s7IGkrKyl7XHJcbiAgICAgICAgICAgIGxldCBwcmludEFyciA9IFtdO1xyXG4gICAgICAgICAgICBmb3IodmFyIGogPSAwOyBqIDwgdGhpcy5fcGF0aHNbaV0uaW5zaWRlOyBqKyspe1xyXG4gICAgICAgICAgICAgICAgcHJpbnRBcnJbal0gPSB0aGlzLl9wYXRoc1tpXS50dW5uZWwoaik7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc29sZS5sb2coXCJJbmRpdmlkdWFsOiBcIiArIGkgKyBcIiBcIiArIHByaW50QXJyLmpvaW4oXCIgLSBcIikpO1xyXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhcIkZpdG5lc3M6IFwiICsgdGhpcy5fcGF0aHNbaV0uaW5kaXZpZHVhbEZpdG5lc3MpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIGRyYXdOZXh0KG5yR2VuczogbnVtYmVyLCB3aGF0R2VuOiBudW1iZXIsIGluZDogUGF0aCwgZmlyc3RGaXQ6IG51bWJlcil7XHJcbiAgICAgICAgbGV0IHggPSAoYy53aWR0aC9uckdlbnMpKndoYXRHZW47XHJcbiAgICAgICAgbGV0IHkgPSAoKDAuOSpjLmhlaWdodCkvZmlyc3RGaXQpKmluZC5pbmRpdmlkdWFsRml0bmVzcztcclxuICAgICAgICBjdHgubGluZVRvKHgsIHkpO1xyXG4gICAgICAgIGN0eC5zdHJva2UoKTtcclxuICAgIH07XHJcbn1cclxuXHJcbmNsYXNzIEFwcCB7XHJcbiAgICBwdWJsaWMgc3RhcnQoKTogdm9pZHtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIlN0YXJ0aW5nIGFwcGxpY2F0aW9uLi4uXCIpO1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFwiQ2xlYXJpbmcgQ2FudmFzXCIpXHJcbiAgICAgICAgdGhpcy5jbGVhcihjLCBjdHgpO1xyXG5cclxuICAgICAgICB2YXIgbnVtOm51bWJlciA9IC0yXHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IG51bSA+IDAgP1wicG9zaXRpdmVcIjpcIm5vbi1wb3NpdGl2ZVwiIFxyXG4gICAgICAgIGNvbnNvbGUubG9nKHJlc3VsdClcclxuXHJcbiAgICAgICAgbGV0IGFsbENpdGllczogQ2l0eVtdID0gW107XHJcblxyXG4gICAgICAgIGxldCBuck9mQ2l0aWVzOiBudW1iZXIgPSBwYXJzZUZsb2F0KG5yQy52YWx1ZSkgfHwgMTA7XHJcbiAgICAgICAgbGV0IG5yT2ZQYXRoczogbnVtYmVyID0gcGFyc2VGbG9hdChuclAudmFsdWUpIHx8IDMzMzM7XHJcbiAgICAgICAgbGV0IG5yT2ZHZW5lcmF0aW9uczogbnVtYmVyID0gcGFyc2VGbG9hdChuckcudmFsdWUpIHx8IDQ7XHJcblxyXG4gICAgICAgIGNvbnNvbGUubG9nKFwiQ3JlYXRpbmcgXCIrIG5yT2ZDaXRpZXMgKyBcIiBDaXRpZXMuLi5cIik7XHJcbiAgICAgICAgZm9yKGxldCBpID0gMDsgaSA8IG5yT2ZDaXRpZXM7IGkrKyl7XHJcbiAgICAgICAgICAgIGxldCBqID0gaSArIDE7XHJcbiAgICAgICAgICAgIGFsbENpdGllc1tpXSA9IG5ldyBDaXR5KHt4OiAoKDUwL01hdGguUEkpICogTWF0aC5jb3MoaSAqICgyICogTWF0aC5QSSkgLyAobnJPZkNpdGllcykpKSwgeTogKCg1MC9NYXRoLlBJKSAqIE1hdGguc2luKGkgKiAoMiAqIE1hdGguUEkpIC8gKG5yT2ZDaXRpZXMpKSl9LCBcIkNcIiArIGopO1xyXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhcIiAgQ2l0eSBuciBcIiArIGkgKyBcIiBcIiArIGFsbENpdGllc1tpXS5pZCArIFwiOiBcIisgYWxsQ2l0aWVzW2ldLlBvaW50WCArIFwiLFwiKyBhbGxDaXRpZXNbaV0uUG9pbnRZKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBsZXQgbXlQb3B1bGF0aW9uOiBQb3B1bGF0aW9uID0gbmV3IFBvcHVsYXRpb24oKTtcclxuICAgICAgICBcclxuICAgICAgICBjb25zb2xlLmxvZyhcIkNyZWF0aW5nIFBvcHVsYXRpb24gb2Ygc2l6ZTogXCIgKyBuck9mUGF0aHMpO1xyXG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCBuck9mUGF0aHM7IGkrKyl7XHJcbiAgICAgICAgICAgIGxldCB0ZW1wQXJyOiBDaXR5W10gPSBhbGxDaXRpZXMuc2xpY2UoMCk7XHJcbiAgICAgICAgICAgIGxldCBteVBhdGg6IFBhdGggPSBuZXcgUGF0aCgpO1xyXG4gICAgICAgICAgICBmb3IodmFyIGogPSAwOyBqIDwgbnJPZkNpdGllczsgaisrKXtcclxuICAgICAgICAgICAgICAgIGlmKGogPCBuck9mQ2l0aWVzIC0gMSl7XHJcbiAgICAgICAgICAgICAgICAgICAgbGV0IHNwbGljZVZhbHVlID0gTWF0aC5yYW5kb20oKSoodGVtcEFyci5sZW5ndGggLSAxKTtcclxuICAgICAgICAgICAgICAgICAgICBsZXQgdGVtcEFkZDogQ2l0eVtdID0gdGVtcEFyci5zcGxpY2UoTWF0aC5jZWlsKE1hdGguZmxvb3Ioc3BsaWNlVmFsdWUpKzAuMSksIDEpO1xyXG4gICAgICAgICAgICAgICAgICAgIG15UGF0aC5hZGRDaXR5KHRlbXBBZGRbMF0pO1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIGNvbnNvbGUubG9nKG15UGF0aC4pICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBsZXQgdGVtcEFkZDogQ2l0eVtdID0gdGVtcEFyci5zcGxpY2UoMCwgMSk7XHJcbiAgICAgICAgICAgICAgICAgICAgbXlQYXRoLmFkZFN0YXJ0KHRlbXBBZGRbMF0pO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIG15UG9wdWxhdGlvbi5hZGRQYXRoKG15UGF0aCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgbXlQb3B1bGF0aW9uLmV2b2x2ZShuck9mR2VuZXJhdGlvbnMpO1xyXG4gICAgICAgIC8vIGN0eC5zdHJva2UoKTtcclxuICAgICAgICBteVBvcHVsYXRpb24uY2hlY2soMSk7XHJcbiAgICB9O1xyXG4gICAgY2xlYXIoY2FudmFzOiBIVE1MQ2FudmFzRWxlbWVudCwgY29udGV4dDogQ2FudmFzUmVuZGVyaW5nQ29udGV4dDJEKSB7XHJcbiAgICAgICAgY29udGV4dC5jbGVhclJlY3QoMCwgMCwgY2FudmFzLndpZHRoLCBjYW52YXMuaGVpZ2h0KTtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIkNsZWFyZWQgY2FudmFzXCIpO1xyXG4gICAgfTtcclxufVxyXG5jb25zdCBhcHAgPSBuZXcgQXBwKCk7XHJcbmZ1bmN0aW9uIGJTdGFydCgpe1xyXG4gICAgYXBwLnN0YXJ0KClcclxufVxyXG5mdW5jdGlvbiBiQ2xlYXIoKSB7XHJcbiAgICBjdHguY2xlYXJSZWN0KDAsIDAsIGMud2lkdGgsIGMuaGVpZ2h0KTtcclxuICAgIGNvbnNvbGUubG9nKFwiQ2xlYXJlZCBDYW52YXNcIik7XHJcbn07XHJcblxyXG5sZXQgbnJDOkhUTUxJbnB1dEVsZW1lbnQgPSA8SFRNTElucHV0RWxlbWVudD4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25yQ2l0aWVzJykhO1xyXG5sZXQgbnJQOkhUTUxJbnB1dEVsZW1lbnQgPSA8SFRNTElucHV0RWxlbWVudD4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ25yUGF0aHMnKSE7XHJcbmxldCBuckc6SFRNTElucHV0RWxlbWVudCA9IDxIVE1MSW5wdXRFbGVtZW50PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnbnJHZW5lcmF0aW9ucycpITtcclxuXHJcbnZhciBjOkhUTUxDYW52YXNFbGVtZW50ID0gPEhUTUxDYW52YXNFbGVtZW50PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm15Q2FudmFzXCIpITtcclxudmFyIGN0eCA9IGMuZ2V0Q29udGV4dChcIjJkXCIpITtcclxuLy8gY3R4LnRyYW5zbGF0ZShjLndpZHRoLCBjLmhlaWdodClcclxuXHJcbmMud2lkdGggPSB3aW5kb3cuaW5uZXJXaWR0aC8yLjI7XHJcbmMuaGVpZ2h0ID0gd2luZG93LmlubmVySGVpZ2h0LzM7XHJcblxyXG4vL1VzZWZ1bGwgZm9yIGxlYXJuaW5nICdyZXF1ZXN0QW5pbWF0aW9uRnJhbWUnOiBodHRwczovL3RoZWJsb2dvZnBldGVyY2hlbi5ibG9nc3BvdC5jb20vMjAxNS8wMi9odG1sNS1oaWdoLXBlcmZvcm1hbmNlLXJlYWwtdGltZS5odG1sIl19